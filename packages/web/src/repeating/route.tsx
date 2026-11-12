/**
 * Repeating (Amendment 216): every schedule, from every project, in one place. "Make it easier to
 * schedule repeating tasks: a message to an agent, or a job like one I ran."
 *
 *   order 84 · hotkey r. Registered by main.tsx's `./＊/route.tsx` glob, like every screen.
 *
 * Grouped by project, each under its name with its colour bar, which opens it, as Notes is. Each row
 * is the Project screen's (`RepeatingRow`, fleet/repeating.tsx): its name, ⟳ job or ⟳ message to
 * its agent, the rule in words and its next time, its last result with a link, and ▶ run now, pause,
 * edit and cancel.
 *
 * + new offers the two kinds. A message to an agent: its project, its agent, the text and the rule.
 * A job like one you ran: its project, one of its jobs Conductor kept the setup of, newest first,
 * with its prompt to keep or change, and the rule (`RepeatJobForm`, the job's own ⟳ repeat…). A new
 * launch is set up in Spawn, which has its own repeat…; the link goes there.
 */

import { useMemo, useState } from 'react';
import type { Agent, Job } from '@conductor/shared';
import { RECURRING_NAME_MAX, everyProblem, recurringNameProblem } from '@conductor/shared';
import type { ScreenDef } from '../lib/screens.js';
import { projClass, projectColors } from '../lib/projectColor.js';
import { useAgents, useJobs, useProjects, useRecurring } from '../lib/store.js';
import { openProject, openSpawn } from '../shell/nav.js';
import { DEFAULT_RULE, RuleFields, ruleOf, type RuleDraft } from '../shell/RuleFields.js';
import { useCommand } from '../agent/endpoints.js';
import { defaultName, ruleLine } from '../spawn/repeat.js';
import { jobWords } from '../fleet/notewords.js';
import { RepeatJobForm, RepeatingRow, repeatableJobs, repeatingGroups, repeatingSummary } from '../fleet/repeating.js';
import { saveRecurringMessage } from '../fleet/endpoints.js';
import './repeating.css';

type Kind = 'message' | 'job';

const KINDS: { id: Kind; label: string; title: string }[] = [
  { id: 'message', label: 'a message to an agent', title: 'Send an agent the same message on a rule' },
  { id: 'job', label: 'a job like one you ran', title: 'Start a new job with the setup of one you ran, on a rule' },
];

/** An agent in the picker: its role, and its job when it has one. */
const agentWords = (a: Agent, jobs: readonly Job[]): string => {
  const job = jobs.find((j) => j.id === a.jobId);
  return job ? `${a.role} · ${jobWords(job)}` : a.role;
};

function ProjectPick({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const projects = useProjects();
  return (
    <select className="rp-pick" aria-label="project" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Pick a project</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/** + new, a message: project → agent → text → rule. The name starts as the text's first line. */
function NewMessage() {
  const cmd = useCommand();
  const allAgents = useAgents();
  const jobs = useJobs();
  const [projectId, setProjectId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [text, setText] = useState('');
  const [named, setNamed] = useState<string | null>(null);
  const [rule, setRule] = useState<RuleDraft>(DEFAULT_RULE);
  const agents = allAgents.filter((a) => a.projectId === projectId);
  const agent = agents.find((a) => a.id === agentId) ?? null;
  const name = named ?? defaultName('', text);
  const every = ruleOf(rule);
  const why =
    (projectId ? null : 'Pick a project first.') ??
    (agent ? null : 'Pick the agent it goes to.') ??
    (text.trim() ? null : 'Write the message first.') ??
    recurringNameProblem(name) ??
    everyProblem(every);

  const save = (): void => {
    if (why !== null || agent === null) return;
    void cmd
      .run('Saving the schedule', () => saveRecurringMessage(name.trim(), every, agent.id, text.trim()), `Saved: it is in ${agent.role}'s list below.`)
      .then((ok) => {
        if (!ok) return;
        setText('');
        setNamed(null);
      });
  };

  return (
    <div className="rp-form" role="group" aria-label="a new repeating message">
      <div className="rp-row">
        <ProjectPick
          value={projectId}
          onChange={(id) => {
            setProjectId(id);
            setAgentId('');
          }}
        />
        <select className="rp-pick" aria-label="agent" value={agentId} disabled={agents.length === 0} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">{projectId && agents.length === 0 ? 'No agents in this project' : 'Pick an agent'}</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {agentWords(a, jobs)}
            </option>
          ))}
        </select>
      </div>
      <textarea className="pj-rep-body" aria-label="the message" rows={3} placeholder="What to send it each time" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="rp-row">
        <span className="ui-lab">repeat as</span>
        <input
          className="pj-rep-input"
          aria-label="name"
          value={name}
          maxLength={RECURRING_NAME_MAX}
          placeholder="A name for the schedule"
          onChange={(e) => setNamed(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="rp-row">
        <RuleFields rule={rule} onChange={setRule} />
        <span className="pj-rep-rule">{ruleLine(rule, new Date())}</span>
      </div>
      <div className="rp-row">
        <button type="button" className="fl-btn is-primary" disabled={cmd.busy || why !== null} onClick={save}>
          {cmd.busy ? 'saving…' : 'save schedule'}
        </button>
        <span className="pj-rep-how">It is sent each time it comes due. One due while Conductor was down or paused goes once, when it is back.</span>
      </div>
      {why && <span className="pj-rep-why">{why}</span>}
      {cmd.notice && (
        <div className={`pj-notice t-${cmd.notice.tone}`} onClick={cmd.dismiss}>
          {cmd.notice.text}
        </div>
      )}
    </div>
  );
}

/** + new, a job: project → one of its repeatable jobs, newest first → its form, prompt prefilled. */
function NewJob() {
  const jobs = useJobs();
  const [projectId, setProjectId] = useState('');
  const [jobId, setJobId] = useState('');
  const choices = repeatableJobs(jobs, projectId);
  const job = choices.find((j) => j.id === jobId) ?? null;
  return (
    <div className="rp-form" role="group" aria-label="a new repeating job">
      <div className="rp-row">
        <ProjectPick
          value={projectId}
          onChange={(id) => {
            setProjectId(id);
            setJobId('');
          }}
        />
        <select className="rp-pick" aria-label="job" value={jobId} disabled={choices.length === 0} onChange={(e) => setJobId(e.target.value)}>
          <option value="">{projectId && choices.length === 0 ? 'No job here can be repeated' : 'Pick a job you ran'}</option>
          {choices.map((j) => (
            <option key={j.id} value={j.id}>
              {jobWords(j)}
            </option>
          ))}
        </select>
      </div>
      {projectId && choices.length === 0 && (
        <span className="pj-rep-how">Only a job launched since Conductor kept its setup can be repeated. Set one up in Spawn and use its repeat….</span>
      )}
      {job && <RepeatJobForm key={job.id} job={job} onClose={() => setJobId('')} />}
    </div>
  );
}

function Repeating() {
  const projects = useProjects();
  const recurring = useRecurring();
  const agents = useAgents();
  const [adding, setAdding] = useState<Kind | null>(null);
  const colors = useMemo(() => projectColors(projects), [projects]);
  const groups = repeatingGroups(projects, recurring);

  return (
    <div className="rp">
      <div className="rp-head">
        <span className="ui-crumb">
          <b>repeating</b>
        </span>
        <button type="button" className="fl-btn is-ghost" aria-expanded={adding !== null} onClick={() => setAdding((k) => (k ? null : 'message'))}>
          + new
        </button>
        <span className="rp-quiet">{repeatingSummary(groups)}</span>
      </div>

      <div className="rp-scroll">
        {adding && (
          <section className="rp-new" aria-label="a new schedule">
            <div className="rp-row">
              <div className="rp-kinds" role="group" aria-label="what repeats">
                {KINDS.map((k) => (
                  <button key={k.id} type="button" className={k.id === adding ? 'on' : ''} aria-pressed={k.id === adding} title={k.title} onClick={() => setAdding(k.id)}>
                    {k.label}
                  </button>
                ))}
              </div>
              <button type="button" className="pj-rep-link" onClick={() => openSpawn()} title="Spawn sets up a launch, and its repeat… saves it to run on a rule">
                set up a new launch in Spawn
              </button>
              <button type="button" className="fl-btn is-ghost" onClick={() => setAdding(null)}>
                close
              </button>
            </div>
            {adding === 'message' ? <NewMessage /> : <NewJob />}
          </section>
        )}

        {groups.length === 0 && !adding && (
          <p className="rp-empty">Nothing repeats yet. + new sends an agent a message on a rule, or runs a job like one you ran.</p>
        )}
        {groups.map(({ project, items }) => (
          <section key={project.id} className={`rp-group ${projClass(colors.get(project.id))}`}>
            <button type="button" className="rp-ghead" title={`Open ${project.name}`} onClick={() => openProject(project.id)}>
              <b>{project.name}</b>
              <span className="rp-quiet">
                {items.length} schedule{items.length === 1 ? '' : 's'}
              </span>
            </button>
            <div className="rp-list">
              {items.map((r) => (
                <RepeatingRow key={r.id} r={r} agents={agents} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export const screen: ScreenDef = {
  id: 'repeating',
  label: 'Repeating',
  hotkey: 'r',
  order: 84,
  Component: Repeating,
};
