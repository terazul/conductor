/**
 * Fleet's "add a project" form (Amendment 45). The one place a project is added.
 *
 * It asks for the NEW project's folders — the main one, where agents work, and any
 * referenced ones they can read and edit too — rather than listing the projects that
 * already exist, which is what Spawn's "where" step did and why it read as if it were
 * asking for this. Nothing is sent until "add project", and the daemon checks every
 * folder before it creates anything.
 */

import { useState } from 'react';
import type { Project } from '@conductor/shared';
import { useCommand } from '../agent/endpoints.js';
import { PathField } from '../spawn/PathField.js';
import { createProject } from './endpoints.js';
import { addReferenced, addedLine, nameFrom, tidyPath } from './addproject.js';

export function NewProject({
  onDone,
  onAdded,
}: {
  onDone: () => void;
  onAdded: (project: Project, line: string) => void;
}) {
  const [main, setMain] = useState('');
  const [name, setName] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [why, setWhy] = useState<string | null>(null);
  const cmd = useCommand();

  const addRef = (): void => {
    const next = addReferenced(refs, draft, main);
    setWhy(next.why);
    if (next.list !== refs) {
      setRefs(next.list);
      setDraft('');
    }
  };

  const submit = (): void => {
    const path = tidyPath(main);
    if (!path || cmd.busy) return;
    // A folder still in the add field is meant, not abandoned.
    const dirs = addReferenced(refs, draft, main).list;
    void cmd.run(
      'Adding the project',
      async () => {
        const r = await createProject({ path, ...(name.trim() ? { name: name.trim() } : {}), dirs });
        if (!r.existing) onAdded(r.project, addedLine(r.project.name, r.project.extraDirs?.length ?? 0, false));
        return r;
      },
      (r: { project: Project; existing: boolean }) =>
        r.existing ? addedLine(r.project.name, 0, true) : '',
    );
  };

  return (
    <div className="fl-newproj" role="form" aria-label="Add a project">
      <p className="fl-f-q">Add a project</p>

      <div className="fl-f">
        <span>main folder — agents work here, and worktrees are cut from it</span>
        <PathField
          value={main}
          onChange={setMain}
          onSubmit={submit}
          onCancel={onDone}
          busy={cmd.busy}
          submitLabel={null}
          placeholder="~/src/your-repo — ⇥ completes, ⏎ adds the project"
          judge="git"
        />
      </div>

      <label className="fl-f">
        <span>name</span>
        <input
          value={name}
          spellCheck={false}
          placeholder={nameFrom(main) || 'the main folder’s name'}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') onDone();
          }}
        />
      </label>

      <div className="fl-f">
        <span>referenced folders — agents can read and edit these too, in place</span>
        {refs.length > 0 && (
          <ul className="fl-dirs">
            {refs.map((d) => (
              <li key={d}>
                <code title={d}>{d}</code>
                <button
                  type="button"
                  className="fl-btn is-ghost"
                  aria-label={`Don't reference ${d}`}
                  onClick={() => setRefs(refs.filter((x) => x !== d))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="fl-np-addrow">
          <PathField
            value={draft}
            onChange={(v) => {
              setDraft(v);
              setWhy(null);
            }}
            onSubmit={addRef}
            onCancel={onDone}
            busy={cmd.busy}
            submitLabel="+ reference"
            placeholder="~/src/shared-lib — optional, ⏎ adds it to the list"
            autoFocus={false}
            judge="git"
          />
        </div>
        {why && <span className="fl-np-judge">{why}</span>}
      </div>

      <div className="fl-menu-row">
        <button
          type="button"
          className="fl-btn is-primary"
          disabled={cmd.busy || tidyPath(main) === ''}
          onClick={submit}
        >
          {cmd.busy ? 'adding…' : 'add project'}
        </button>
        <button type="button" className="fl-btn is-ghost" disabled={cmd.busy} onClick={onDone}>
          cancel
        </button>
      </div>
      {cmd.notice && (
        <div className={`fl-menu-note t-${cmd.notice.tone}`} onClick={cmd.dismiss}>
          {cmd.notice.text}
        </div>
      )}
    </div>
  );
}
