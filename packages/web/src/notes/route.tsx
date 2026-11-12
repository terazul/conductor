/**
 * Notes (Amendment 214): every note, from every project, in one place. "Provide a way to view all
 * the notes that were typed on various agents."
 *
 *   order 82 · hotkey n. Registered by main.tsx's `./＊/route.tsx` glob, like every screen.
 *
 * A note is still its project's (Amendment 55), so this reads the projects the page already has and
 * asks the daemon nothing. They are grouped by project, each under its name with its colour bar,
 * which opens it. Late notes come first, then those due today, then the newest (`noteGroups`,
 * fleet/notewords.ts, pure, so lib/verify.ts checks it).
 *
 * The filters: a project, an agent (those whose screens have notes on them), open, done or all
 * (open to begin with), and words the text holds, each of them. They last while the page does: kept
 * in `kept` below, outside the screen, which main.tsx unmounts whenever another is shown.
 *
 * Each row is the one every project's list has (`NoteRow`, fleet/Notes.tsx): tick done, copy, edit,
 * delete and the due badge, and the agent it was typed beside, which opens it.
 */

import { useMemo, useState } from 'react';
import type { ScreenDef } from '../lib/screens.js';
import { projClass, projectColors } from '../lib/projectColor.js';
import { useAgents, useJobs, useProjects } from '../lib/store.js';
import { useNow } from '../shell/clock.js';
import { openProject } from '../shell/nav.js';
import { NoteRow } from '../fleet/Notes.js';
import { NO_NOTE_FILTER, jobWords, localDate, noteAgents, noteGroups, notesSummary, type NoteFilter, type NoteShow } from '../fleet/notewords.js';
import './notes.css';

const SHOWS: { id: NoteShow; label: string; title: string }[] = [
  { id: 'open', label: 'open', title: 'Notes not ticked done' },
  { id: 'done', label: 'done', title: 'Notes ticked done' },
  { id: 'all', label: 'all', title: 'Every note' },
];

/** The filters as last set, so leaving the screen and coming back keeps them until the page reloads. */
let kept: NoteFilter = NO_NOTE_FILTER;

function Notes() {
  const projects = useProjects();
  const allAgents = useAgents();
  const jobs = useJobs();
  const today = localDate(useNow(60_000));
  const [filter, setFilter] = useState<NoteFilter>(() => kept);
  const set = (patch: Partial<NoteFilter>): void => setFilter((f) => (kept = { ...f, ...patch }));
  const colors = useMemo(() => projectColors(projects), [projects]);
  // A project or agent that has since gone is every project, or any agent, again.
  const projectId = filter.projectId !== null && projects.some((p) => p.id === filter.projectId) ? filter.projectId : null;
  const jobOf = (agentId: string): string | undefined => {
    const job = jobs.find((j) => j.id === allAgents.find((a) => a.id === agentId)?.jobId);
    return job ? jobWords(job) : undefined;
  };
  const agents = noteAgents(projects, projectId, jobOf);
  const agentId = filter.agentId !== null && agents.some((a) => a.agentId === filter.agentId) ? filter.agentId : null;
  const shown = { ...filter, projectId, agentId };
  const groups = noteGroups(projects, shown, today);

  return (
    <div className="nt">
      <div className="nt-head">
        <span className="ui-crumb">
          <b>notes</b>
        </span>
        <select
          className="nt-pick"
          aria-label="project"
          title="Whose notes to show"
          value={projectId ?? ''}
          onChange={(e) => set({ projectId: e.target.value || null, agentId: null })}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          className="nt-pick"
          aria-label="agent"
          title="Notes typed on one agent's screen"
          value={agentId ?? ''}
          disabled={agents.length === 0}
          onChange={(e) => set({ agentId: e.target.value || null })}
        >
          <option value="">Any agent</option>
          {agents.map((a) => (
            <option key={a.agentId} value={a.agentId}>
              {a.label}
            </option>
          ))}
        </select>
        <div className="nt-show" role="group" aria-label="which notes">
          {SHOWS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === filter.show ? 'on' : ''}
              aria-pressed={s.id === filter.show}
              title={s.title}
              onClick={() => set({ show: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input
          className="nt-search"
          type="search"
          aria-label="Search the notes"
          placeholder="search"
          value={filter.q}
          onChange={(e) => set({ q: e.target.value })}
        />
        <span className="nt-quiet">{notesSummary(groups, filter.show)}</span>
      </div>

      <div className="nt-scroll">
        {groups.length === 0 && (
          <p className="nt-empty">
            {projects.some((p) => (p.notes?.length ?? 0) > 0)
              ? 'No note matches. Change the filters above.'
              : 'No notes yet. Write one on a Fleet card, the Project screen, or an agent’s screen.'}
          </p>
        )}
        {groups.map(({ project, notes }) => (
          <section key={project.id} className={`nt-group ${projClass(colors.get(project.id))}`}>
            <button type="button" className="nt-ghead" title={`Open ${project.name}`} onClick={() => openProject(project.id)}>
              <b>{project.name}</b>
              <span className="nt-quiet">
                {notes.length} note{notes.length === 1 ? '' : 's'}
              </span>
            </button>
            <ul className="fl-note-list nt-list">
              {notes.map((n) => (
                <NoteRow key={n.id} project={project} note={n} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export const screen: ScreenDef = {
  id: 'notes',
  label: 'Notes',
  hotkey: 'n',
  order: 82,
  Component: Notes,
};
