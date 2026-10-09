/**
 * Screen 9 — SETTINGS. (Amendment 47)
 *
 * One place for what changes how Conductor behaves, which used to be spread around or
 * not in the UI at all. Every value here is a setting the daemon keeps in
 * `~/.conductor/settings.json` (Amendment 46), so a change here is a change in every
 * browser, and the next start.
 *
 * Reserved slot: order 90, hotkey `9`.
 */

import { useCallback, useEffect, useState } from 'react';
import type { EffortLevel, Isolation, ModelTier, RuleView } from '@conductor/shared';
import type { ScreenDef } from '../lib/screens.js';
import { useProjects, useStatusBar } from '../lib/store.js';
import { highlight, recall } from '../shell/nav.js';
import { REVOKE_NOTE, copyLine, listRules, revokeRule, ruleOrigin, ruleTitle } from './rules.js';
import { readSetting, useSetting, writeSetting } from '../lib/settings.js';
import { useModels } from '../lib/models.js';
import { ModelSelect } from '../shell/ui.js';
import { chooseTheme, useTheme, type ThemeChoice } from '../shell/theme.js';
import { AGENT_INSPECTOR, AGENT_NEEDS, PREVIEW_DOCK, PROJECT_COLUMN, PROJECT_DOCK, QUEUE_PANEL } from '../shell/panels.js';
import { EFFORTS, MODES, PILLS } from '../spawn/autonomy.js';
import { PRESETS } from '../spawn/presets.js';
import { BUILT_IN, LAUNCH_KEYS, launchDefaults, launchPatch, type LaunchDefaults } from '../spawn/defaults.js';
import {
  PERSONAS_KEY,
  isEdited,
  newPersonaId,
  personasFrom,
  resetPersona,
  withPersona,
  withoutPersona,
  type Persona,
  type PersonaTools,
} from '../spawn/personas.js';
import { errorText } from '../lib/errors.js';
import { homeish, saveHome } from './storage.js';
import { setStorage, useStorage } from './always.js';
import { SLOTS_DEFAULT, SLOTS_KEY, SLOTS_MAX, slotsProblem } from './slots.js';
import { DAILY_KEY, OVER_AT, WARN_AT, budgetProblem, dailyMeter, parseBudget } from '../shell/spend.js';
import {
  keyLine,
  loginLine,
  readCopilotLogin,
  readKeyState,
  saveKey,
  type CopilotLogin,
  type OpenRouterKeyState,
} from '../lib/providers.js';
import './settings.css';

const ISOLATION_WORDS: Record<Isolation, string> = {
  worktree: 'new worktree',
  branch: 'new branch',
  in_place: 'this folder, as-is',
};

/** The sizes and folds a reset puts back. Named here so nothing is missed by accident. */
const LAYOUT_KEYS = [
  AGENT_INSPECTOR.key,
  AGENT_NEEDS.key,
  QUEUE_PANEL.key,
  PROJECT_COLUMN.key,
  PROJECT_DOCK.key,
  PREVIEW_DOCK.key,
  'conductor.composerH',
  'conductor.filesTreeW',
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="st-sec">
      <h2 className="ui-lab">{title}</h2>
      {children}
    </section>
  );
}

function StorageSection() {
  const s = useStorage();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!s) return <p className="st-dim">Asking the daemon…</p>;
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStorage(await saveHome());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {s.mode === 'home' && (
        <p>
          Kept in <code>{homeish(s.dir)}</code>: the database, and these settings in{' '}
          <code>settings.json</code>.
        </p>
      )}
      {s.mode === 'override' && (
        <p>
          The database is <code>{s.db}</code>, named by <code>CONDUCTOR_DB</code>. Settings are not
          saved: they last until the daemon stops.
        </p>
      )}
      {s.mode === 'memory' && (
        <>
          <p className="st-warn">
            Nothing is being saved. Conductor is running in memory, so projects, transcripts and these
            settings go when it stops.
          </p>
          {s.savedAt ? (
            <p>
              Saved to <code>{homeish(s.dir)}</code>. Restart Conductor (<code>make restart</code>) to
              keep saving there.
            </p>
          ) : (
            <button type="button" className="st-btn" disabled={busy} onClick={() => void save()}>
              {busy ? 'saving…' : `save to ${homeish(s.dir)}`}
            </button>
          )}
        </>
      )}
      {s.legacy && (
        <p className="st-dim">
          The database from before, <code>{homeish(s.legacy)}</code>, is left where it is and not opened.
        </p>
      )}
      {error && <p className="st-err">{error}</p>}
    </>
  );
}

function SlotsSection() {
  const stored = useSetting(SLOTS_KEY);
  const { slots } = useStatusBar();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? stored ?? String(slots.total || SLOTS_DEFAULT);
  const problem = draft === null ? null : slotsProblem(draft);
  const commit = (): void => {
    if (draft === null || problem) return;
    writeSetting(SLOTS_KEY, draft.trim() === String(SLOTS_DEFAULT) ? null : draft.trim());
    setDraft(null);
  };
  return (
    <>
      <label className="st-field">
        <span>agents running at once</span>
        <input
          type="number"
          min={1}
          max={SLOTS_MAX}
          value={shown}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setDraft(null);
          }}
        />
        <span className="st-dim">
          {slots.used} running now. Default {SLOTS_DEFAULT}, up to {SLOTS_MAX}.
        </span>
      </label>
      {problem ? (
        <p className="st-err">{problem}</p>
      ) : (
        <p className="st-dim">
          Applies at once. Raising it starts agents that are waiting for a slot. Lowering it stops
          nobody: running agents finish, and nothing new starts until fewer than the limit are running.
        </p>
      )}
    </>
  );
}

/** The daily budget (Amendment 59): the status bar's meter, and a warning when reached. */
function SpendSection() {
  const stored = useSetting(DAILY_KEY);
  const { costToday } = useStatusBar();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? stored ?? '';
  const problem = draft === null ? null : budgetProblem(draft);
  const budget = parseBudget(stored);
  const commit = (): void => {
    if (draft === null || problem) return;
    writeSetting(DAILY_KEY, draft.trim() === '' ? null : String(Number(draft.trim())));
    setDraft(null);
  };
  return (
    <>
      <label className="st-field">
        <span>daily budget, in dollars — empty for none</span>
        <input
          inputMode="decimal"
          value={shown}
          placeholder="none"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setDraft(null);
          }}
        />
      </label>
      {problem ? (
        <p className="st-err">{problem}</p>
      ) : (
        <p className="st-dim">
          {budget !== null ? `${dailyMeter(costToday, budget).label}. ` : `$${costToday.toFixed(2)} spent today. `}
          The status bar shows it as a bar: yellow from {Math.round(WARN_AT * 100)}%, red from{' '}
          {Math.round(OVER_AT * 100)}%. Reaching it is a warning in Needs You; nothing is stopped. The day is yours:
          it resets at midnight here.
        </p>
      )}
    </>
  );
}

/**
 * The engines other than Claude (Amendment 80): OpenRouter's key, and the Copilot login.
 *
 * THE KEY IS WRITE-ONLY. The daemon says whether one is set and where from, and nothing
 * more; this screen never holds it except in the field while you type, and empties the
 * field once it has been sent, whether or not the daemon took it. It is never written to
 * a setting — every setting is broadcast to every tab.
 */
function ProvidersSection() {
  // undefined: still asking. null: this daemon has no such route.
  const [key, setKey] = useState<OpenRouterKeyState | null | undefined>(undefined);
  const [login, setLogin] = useState<CopilotLogin | null | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const failed = (err: unknown): void => {
      if (live) setError(errorText(err));
    };
    readKeyState().then((k) => {
      if (live) setKey(k);
    }, failed);
    readCopilotLogin().then((l) => {
      if (live) setLogin(l);
    }, failed);
    return () => {
      live = false;
    };
  }, []);

  const send = async (next: string | null): Promise<void> => {
    setBusy(true);
    setSaid(null);
    setError(null);
    try {
      setKey(await saveKey(next));
      setSaid(next === null ? 'Cleared.' : 'Saved.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDraft('');
      setBusy(false);
    }
  };

  const fromEnv = key?.source === 'env';
  return (
    <>
      <div className="st-field">
        <span>OpenRouter key</span>
        <p className="st-dim">{key === undefined ? (error ? '—' : 'Asking the daemon…') : keyLine(key)}</p>
      </div>
      {key && !fromEnv && (
        <div className="st-row">
          <input
            type="password"
            className="st-key"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder={key.set ? 'paste a new key to replace it' : 'paste a key'}
            aria-label="OpenRouter API key"
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) void send(draft.trim());
              else if (e.key === 'Escape') setDraft('');
            }}
          />
          <button type="button" className="st-btn" disabled={busy || !draft.trim()} onClick={() => void send(draft.trim())}>
            {busy ? 'saving…' : 'save'}
          </button>
          {key.set && key.source === 'settings' && (
            <button type="button" className="st-btn st-danger" disabled={busy} onClick={() => void send(null)}>
              clear
            </button>
          )}
        </div>
      )}
      <div className="st-field">
        <span>GitHub Copilot</span>
        <p className="st-dim">{login === undefined ? (error ? '—' : 'Asking the daemon…') : loginLine(login)}</p>
        {login?.note && !login.authenticated && <p className="st-dim">{login.note}</p>}
      </div>
      {said && <p className="st-ok">{said}</p>}
      {error && <p className="st-err">{error}</p>}
    </>
  );
}

function LaunchSection() {
  // Every launch key, so a change to any re-renders this.
  for (const k of Object.values(LAUNCH_KEYS)) useSetting(k);
  const d = launchDefaults(readSetting);
  const models = useModels();
  const put = (patch: Partial<LaunchDefaults>): void => {
    for (const [k, v] of Object.entries(launchPatch({ ...d, ...patch }))) writeSetting(k, v);
  };
  const same = JSON.stringify(d) === JSON.stringify(BUILT_IN);
  return (
    <>
      <p className="st-dim">What Spawn starts from. You can still change any of it for one launch.</p>
      <div className="st-field">
        <span>who works on it</span>
        <div className="st-pills">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="st-pill" aria-pressed={d.preset === p.id} onClick={() => put({ preset: p.id })}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="st-field">
        <span>model</span>
        <ModelSelect
          catalog={models.catalog}
          value={d.model ?? ''}
          none="per role — each preset's own"
          onChange={(id) => put({ model: id || null })}
          onRefresh={models.refresh}
          loading={models.loading}
        />
      </div>
      <div className="st-field">
        <span>isolation</span>
        <div className="st-pills">
          {(Object.keys(ISOLATION_WORDS) as Isolation[]).map((iso) => (
            <button key={iso} type="button" className="st-pill" aria-pressed={d.isolation === iso} onClick={() => put({ isolation: iso })}>
              {ISOLATION_WORDS[iso]}
            </button>
          ))}
        </div>
      </div>
      <div className="st-field">
        <span>how the agents interact with you</span>
        <div className="st-pills">
          {MODES.map((m) => (
            <button key={m.id} type="button" className="st-pill" title={m.warn ?? m.hint} aria-pressed={d.mode === m.id} onClick={() => put({ mode: m.id })}>
              {m.warn ? '⚠ ' : ''}
              {m.label}
            </button>
          ))}
        </div>
        {MODES.find((m) => m.id === d.mode)?.warn && <p className="st-warn">{MODES.find((m) => m.id === d.mode)!.warn}</p>}
      </div>
      <div className="st-field">
        <span>how much rope — on means the agent may do it unattended</span>
        <div className="st-pills">
          {PILLS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="st-pill"
              title={p.hint}
              aria-pressed={d.pills[p.id] === true}
              onClick={() => put({ pills: { ...d.pills, [p.id]: !d.pills[p.id] } })}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="st-field">
        <span>effort</span>
        <div className="st-pills">
          {EFFORTS.map((e) => (
            <button key={e.id} type="button" className="st-pill" title={e.hint} aria-pressed={d.effort === e.id} onClick={() => put({ effort: e.id as EffortLevel })}>
              {e.label}
            </button>
          ))}
        </div>
      </div>
      <label className="st-field">
        <span>budget per agent, in dollars — empty for no cap</span>
        <input
          inputMode="decimal"
          defaultValue={d.budget}
          key={d.budget}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v === '' || (Number.isFinite(Number(v)) && Number(v) > 0)) put({ budget: v });
            else e.target.value = d.budget;
          }}
        />
      </label>
      {!same && (
        <button type="button" className="st-btn" onClick={() => put(BUILT_IN)}>
          back to the built-in defaults
        </button>
      )}
    </>
  );
}

// ── personas (Amendment 68) ─────────────────────────────────────────────────

const TIERS: ModelTier[] = ['opus', 'sonnet', 'haiku'];

/** The five tool rules, worded as the launch's pills are. */
const TOOL_RULES: { id: keyof PersonaTools; label: string; hint: string }[] = [
  { id: 'bash', label: 'run shell unattended', hint: 'On: shell commands run without asking. Off: each one waits for you.' },
  { id: 'push', label: 'allow git push', hint: 'Off adds a deny rule on `git push` that survives every permission mode.' },
  { id: 'network', label: 'allow network', hint: 'Off blocks WebFetch and WebSearch.' },
  { id: 'mcp', label: 'allow MCP tools', hint: "On: your MCP servers' tools run without asking. Off: each one waits for you." },
  { id: 'write', label: 'write files', hint: 'Off makes it a reading persona: the write tools are denied, whatever the launch says.' },
];

/** A three-way rule: what the persona says, or nothing, which leaves it to the launch. */
const RULE_CHOICES: { value: boolean | undefined; label: string }[] = [
  { value: true, label: 'on' },
  { value: false, label: 'off' },
  { value: undefined, label: "the launch's" },
];

const skillsText = (skills: readonly string[]): string => skills.join(', ');
const skillsFrom = (text: string): string[] => [...new Set(text.split(',').map((s) => s.trim()).filter(Boolean))];

/** One persona at a time: every field, saved together or not at all. */
function PersonaEditor({
  initial,
  isNew,
  onSave,
  onCancel,
}: {
  initial: Persona;
  isNew: boolean;
  onSave: (p: Persona) => void;
  onCancel: () => void;
}) {
  const models = useModels();
  const [p, setP] = useState<Persona>(initial);
  const [skills, setSkills] = useState(skillsText(initial.skills));
  // An exact id is a choice of its own, so picking "an exact model…" shows the picker
  // before there is an id in it.
  const [exact, setExact] = useState(initial.model !== '' && !TIERS.includes(initial.model as ModelTier));
  const [problem, setProblem] = useState<string | null>(null);
  const put = (patch: Partial<Persona>): void => setP((was) => ({ ...was, ...patch }));
  const rule = (id: keyof PersonaTools, value: boolean | undefined): void => {
    const tools = { ...p.tools };
    if (value === undefined) delete tools[id];
    else tools[id] = value;
    put({ tools });
  };
  const save = (): void => {
    if (!p.name.trim()) return setProblem('A persona needs a name.');
    onSave({ ...p, name: p.name.trim(), description: p.description.trim(), skills: skillsFrom(skills) });
  };
  return (
    <div className="st-persona-edit">
      <h3 className="ui-lab">{isNew ? 'new persona' : `editing ${initial.name}`}</h3>
      <label className="st-field">
        <span>name — and, by default, the role an agent gets</span>
        <input className="st-wide" value={p.name} maxLength={60} onChange={(e) => put({ name: e.target.value })} />
      </label>
      <label className="st-field">
        <span>description</span>
        <input className="st-wide" value={p.description} onChange={(e) => put({ description: e.target.value })} />
      </label>
      <label className="st-field">
        <span>brief — added to the job prompt</span>
        <textarea className="st-text" rows={3} value={p.brief} onChange={(e) => put({ brief: e.target.value })} />
      </label>
      <label className="st-field">
        <span>system prompt</span>
        <textarea
          className="st-text"
          rows={6}
          maxLength={20_000}
          value={p.systemPrompt}
          placeholder="nothing appended"
          onChange={(e) => put({ systemPrompt: e.target.value })}
        />
        <span className="st-dim">
          Appended to Claude Code's own system prompt, not in place of it, so the agent keeps its tools'
          instructions. Up to 20,000 characters.
        </span>
      </label>
      <div className="st-field">
        <span>model</span>
        <div className="st-row">
          <select
            className="ui-select"
            value={exact ? 'exact' : p.model}
            onChange={(e) => {
              const v = e.target.value;
              setExact(v === 'exact');
              if (v !== 'exact') put({ model: v });
            }}
          >
            <option value="">the launch's choice</option>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value="exact">an exact model…</option>
          </select>
          {exact && (
            <ModelSelect
              catalog={models.catalog}
              value={TIERS.includes(p.model as ModelTier) ? '' : p.model}
              none="pick one"
              onChange={(id) => put({ model: id })}
              onRefresh={models.refresh}
              loading={models.loading}
            />
          )}
        </div>
      </div>
      <div className="st-field">
        <span>tool rules — the launch's leaves it to the pills</span>
        <div className="st-rulegrid">
          {TOOL_RULES.map((r) => (
            <div key={r.id} className="st-rulerow">
              <span title={r.hint}>{r.label}</span>
              <span className="st-pills">
                {RULE_CHOICES.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    className="st-pill"
                    aria-pressed={p.tools[r.id] === c.value}
                    onClick={() => rule(r.id, c.value)}
                  >
                    {c.label}
                  </button>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
      <label className="st-field">
        <span>skills to preload — names, separated by commas</span>
        <input className="st-wide" value={skills} placeholder="Claude Code's defaults" onChange={(e) => setSkills(e.target.value)} />
        <span className="st-dim">Only these are offered to the agent. Empty: every skill Claude Code would offer.</span>
      </label>
      {problem && <p className="st-err">{problem}</p>}
      <div className="st-row">
        <button type="button" className="st-btn" onClick={save}>
          save
        </button>
        <button type="button" className="st-btn" onClick={onCancel}>
          cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Personas (Amendment 68): what each role is. The built-ins can be changed and put back
 * but not deleted; yours can be deleted. Spawn reads the same setting, so a change here
 * is what the next launch gets. A running or sleeping agent keeps what it launched with.
 */
function PersonasSection() {
  const raw = useSetting(PERSONAS_KEY);
  const list = personasFrom(raw);
  const [draft, setDraft] = useState<{ persona: Persona; isNew: boolean } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const save = (p: Persona): void => {
    writeSetting(PERSONAS_KEY, withPersona(raw, p));
    setDraft(null);
    setSaid(`Saved ${p.name}. The next launch uses it.`);
  };
  const reset = (p: Persona): void => {
    writeSetting(PERSONAS_KEY, resetPersona(raw, p.id));
    if (draft?.persona.id === p.id) setDraft(null);
    setSaid(`${p.name} is back as it shipped.`);
  };
  const remove = (p: Persona): void => {
    writeSetting(PERSONAS_KEY, withoutPersona(raw, p.id));
    setConfirm(null);
    if (draft?.persona.id === p.id) setDraft(null);
    setSaid(`Deleted ${p.name}. Agents launched as it keep what they launched with.`);
  };
  const create = (): void => {
    const id = newPersonaId(list);
    setConfirm(null);
    setSaid(null);
    setDraft({
      persona: { id, name: '', description: '', brief: '', systemPrompt: '', model: '', tools: {}, skills: [], builtIn: false },
      isNew: true,
    });
  };

  return (
    <>
      <p className="st-dim">
        What each role is. A preset takes the persona of the same role for its system prompt, skills and tool
        rules, and keeps its own brief and model. A running agent keeps what it launched with.
      </p>
      <ul className="st-rules">
        {list.map((p) => (
          <li key={p.id} aria-current={draft?.persona.id === p.id ? 'true' : undefined}>
            <div className="st-rule-main">
              <span className="st-persona-name">
                <code>{p.name}</code>
                {p.builtIn && isEdited(p) && (
                  <span className="st-changed" title="Changed from the built-in. Reset puts it back.">
                    changed
                  </span>
                )}
                {!p.builtIn && <span className="st-dim">yours</span>}
              </span>
              <span className="st-dim">{p.description || 'No description.'}</span>
            </div>
            <span className="st-row st-persona-acts">
              <button
                type="button"
                className="st-btn"
                onClick={() => {
                  setConfirm(null);
                  setSaid(null);
                  setDraft({ persona: { ...p, tools: { ...p.tools }, skills: [...p.skills] }, isNew: false });
                }}
              >
                edit
              </button>
              {p.builtIn && isEdited(p) && (
                <button type="button" className="st-btn" onClick={() => reset(p)}>
                  reset
                </button>
              )}
              {!p.builtIn &&
                (confirm === p.id ? (
                  <>
                    <button type="button" className="st-btn st-danger" onClick={() => remove(p)}>
                      delete
                    </button>
                    <button type="button" className="st-btn" onClick={() => setConfirm(null)}>
                      keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="st-btn" onClick={() => setConfirm(p.id)}>
                    delete…
                  </button>
                ))}
            </span>
          </li>
        ))}
      </ul>
      {draft ? (
        <PersonaEditor
          key={draft.persona.id}
          initial={draft.persona}
          isNew={draft.isNew}
          onSave={save}
          onCancel={() => setDraft(null)}
        />
      ) : (
        <button type="button" className="st-btn" onClick={create}>
          + new persona
        </button>
      )}
      {said && <p className="st-ok">{said}</p>}
    </>
  );
}

const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: '◐ follow the system' },
  { id: 'light', label: '☀ light' },
  { id: 'dark', label: '☾ dark' },
];

function LookSection() {
  const { choice } = useTheme();
  const [done, setDone] = useState<string | null>(null);
  return (
    <>
      <div className="st-field">
        <span>theme</span>
        <div className="st-pills">
          {THEMES.map((t) => (
            <button key={t.id} type="button" className="st-pill" aria-pressed={choice === t.id} onClick={() => chooseTheme(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="st-row">
        <button
          type="button"
          className="st-btn"
          onClick={() => {
            for (const k of LAYOUT_KEYS) writeSetting(k, null);
            setDone('Every panel is back to its usual size.');
          }}
        >
          reset panel sizes
        </button>
        <button
          type="button"
          className="st-btn"
          onClick={() => {
            writeSetting('conductor.agentFolds', null);
            setDone('Every reply is unfolded.');
          }}
        >
          unfold every reply
        </button>
      </div>
      {done && <p className="st-dim">{done}</p>}
      <p className="st-dim">Notifications and the chime are switched on the Needs you screen (4).</p>
    </>
  );
}

function PermissionsSection() {
  const projects = useProjects();
  const [picked, setPicked] = useState<string | null>(null);
  // The highlighted project, like Files (Amendment 44), until you pick another here.
  const projectId =
    picked ?? (projects.some((p) => p.id === recall().projectId) ? recall().projectId! : (projects[0]?.id ?? null));
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!projectId) return;
    setError(null);
    listRules(projectId).then(
      (r) => setRules(r.rules),
      (err: unknown) => setError(errorText(err)),
    );
  }, [projectId]);
  useEffect(() => {
    setRules(null);
    setConfirm(null);
    setSaid(null);
    load();
  }, [load]);

  const revoke = async (r: RuleView): Promise<void> => {
    try {
      const { removed } = await revokeRule(r.id);
      setConfirm(null);
      setSaid([`Revoked ${ruleTitle(removed)}.`, copyLine(removed)].filter(Boolean).join(' '));
      load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (projects.length === 0) return <p className="st-dim">No projects yet.</p>;
  return (
    <>
      <label className="st-field">
        <span>project</span>
        <select
          className="ui-select"
          value={projectId ?? ''}
          onChange={(e) => {
            setPicked(e.target.value);
            highlight(e.target.value);
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p className="st-dim">
        What you answered <b>allow always</b> to. Conductor allows a matching call from any agent in this
        project without asking.
      </p>
      {rules === null && !error && <p className="st-dim">Reading…</p>}
      {rules?.length === 0 && <p className="st-dim">Nothing is allowed always here.</p>}
      {rules && rules.length > 0 && (
        <ul className="st-rules">
          {rules.map((r) => (
            <li key={r.id}>
              <div className="st-rule-main">
                <code>{ruleTitle(r)}</code>
                <span className="st-dim">{ruleOrigin(r)}</span>
                {copyLine(r) && <span className="st-dim">{copyLine(r)}</span>}
              </div>
              {confirm === r.id ? (
                <span className="st-row">
                  <button type="button" className="st-btn st-danger" onClick={() => void revoke(r)}>
                    revoke
                  </button>
                  <button type="button" className="st-btn" onClick={() => setConfirm(null)}>
                    keep
                  </button>
                </span>
              ) : (
                <button type="button" className="st-btn" onClick={() => setConfirm(r.id)} title={REVOKE_NOTE}>
                  revoke…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {confirm && <p className="st-dim">{REVOKE_NOTE}</p>}
      {said && <p className="st-ok">{said}</p>}
      {error && <p className="st-err">{error}</p>}
    </>
  );
}

function Settings() {
  return (
    <div className="st-screen">
      <div className="st-col">
        <Section title="Where it is kept">
          <StorageSection />
        </Section>
        <Section title="Agents">
          <SlotsSection />
        </Section>
        <Section title="Spend">
          <SpendSection />
        </Section>
        <Section title="Providers">
          <ProvidersSection />
        </Section>
        <Section title="Launch defaults">
          <LaunchSection />
        </Section>
        <Section title="Personas">
          <PersonasSection />
        </Section>
        <Section title="Allowed always">
          <PermissionsSection />
        </Section>
        <Section title="Look">
          <LookSection />
        </Section>
      </div>
    </div>
  );
}

export const screen: ScreenDef = {
  id: 'settings',
  label: 'Settings',
  hotkey: '9',
  order: 90,
  Component: Settings,
};
