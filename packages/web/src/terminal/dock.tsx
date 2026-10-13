/**
 * The Terminal dock (Amendment 141; plan D8b): a project's shells, under every screen.
 *
 * Ctrl-` opens and closes it, from anywhere, a terminal included (Xterm.tsx lets the key
 * through), and so does the status bar's **▸ terminal**. It shows the terminals of the project
 * you are on (the one the navigator highlights, `currentProject`, shell/navtree.ts:344), in tabs,
 * each starting in the project folder; **+** opens another. Its height is dragged at its top edge
 * and remembered (`TERMINAL_DOCK`, shell/panels.ts), and whether it is up is a setting too, so a
 * reload or another browser finds it as you left it.
 *
 * The shells are the daemon's (project-scoped, daemon/src/terminal/service.ts): closing the dock,
 * or moving to another project, lets go of them and nothing more. They end when closed with ×,
 * when the project is removed, or when the daemon stops.
 *
 * It replaces the Project screen dock's placeholder terminal tab (fleet/dock.tsx), which now
 * opens this.
 */

import { useEffect } from 'react';
import { useAgents, useProjects } from '../lib/store.js';
import { readSetting, useSetting, writeSetting } from '../lib/settings.js';
import { recall } from '../shell/nav.js';
import { currentProject } from '../shell/navtree.js';
import { useRoute } from '../shell/Navigator.js';
import { TERMINAL_DOCK, usePanel } from '../shell/panels.js';
import { Splitter } from '../shell/Splitter.js';
import { dirRoot } from '../files/tabs.js';
import { TermTabs } from '../agent/TermPanel.js';
import { DOCK_OPEN_KEY, dockFlipped, dockShown } from './prefs.js';
import { dockKey } from './keys.js';
import './terminal.css';

/** Open the dock if it is down, close it if it is up. */
export function toggleDock(): void {
  writeSetting(DOCK_OPEN_KEY, dockFlipped(readSetting(DOCK_OPEN_KEY)));
}

/** Open it, whatever it was: the Project screen's ▸ terminal tab. */
export function openDock(): void {
  writeSetting(DOCK_OPEN_KEY, 'open');
}

/** Ctrl-`, anywhere on the page. Mounted once, by the shell. */
export function useDockKey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!dockKey(e) || e.repeat) return;
      e.preventDefault();
      toggleDock();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
}

/** The status bar's button. */
export function DockButton() {
  const up = dockShown(useSetting(DOCK_OPEN_KEY));
  return (
    <button type="button" className="tm-dockbtn" aria-pressed={up} onClick={toggleDock} title={`${up ? 'Close' : 'Open'} the terminal dock (Ctrl-\`)`}>
      ▸ terminal <kbd>Ctrl-`</kbd>
    </button>
  );
}

export function TerminalDock() {
  const up = dockShown(useSetting(DOCK_OPEN_KEY));
  const route = useRoute();
  const agents = useAgents();
  const projects = useProjects();
  const { size, handle } = usePanel(TERMINAL_DOCK);
  if (!up) return null;
  const id = currentProject(route, agents, recall().projectId) ?? projects[0]?.id;
  const project = projects.find((p) => p.id === id) ?? null;

  return (
    <>
      <Splitter orientation="horizontal" grow={-1} label="Resize the terminal dock" {...handle} />
      <section className="tm-dock" style={{ height: `${size}px` }} aria-label="Terminal dock">
        <div className="tm-dock-head">
          <span className="ui-lab">Terminal</span>
          <span className="tm-dock-project">{project ? project.name : 'no project'}</span>
          <button type="button" className="tm-dock-x" onClick={toggleDock} title="Close the dock (Ctrl-`). The shells keep running." aria-label="Close the terminal dock">
            ×
          </button>
        </div>
        <div className="tm-dock-body">
          {project ? (
            <TermTabs
              key={project.id}
              scope={{ kind: 'project', projectId: project.id }}
              // A project's shells start in its folder; their paths open in Files under that folder.
              links={(t) => ({ cwd: t.cwd, root: project.path, filesRoot: dirRoot(project.id, project.path) })}
            />
          ) : (
            <p className="ag-termx-wait">Add a project, or pick one in the navigator, to open a terminal in its folder.</p>
          )}
        </div>
      </section>
    </>
  );
}
