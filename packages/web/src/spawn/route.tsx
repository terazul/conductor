/**
 * Screen 7 — Spawn. How work starts. Track A owns this file.
 *
 * Hotkey `7`, order 70 (CONTRACT.md §3 reserved slots).
 *
 * Follows the mockup's five steps — what needs doing, where, how isolated, who
 * works on it, how much rope — and its promise that you see the agent plan,
 * including what runs in parallel and what waits, BEFORE launching.
 *
 * Two deliberate departures from the mockup, both for the same reason:
 *  - the launch button is not amber. `--need` means "a human is required" and
 *    nothing else; a primary button the user is already looking at does not
 *    qualify (CONTRACT.md §5.1). Amber is spent on the autonomy pills that
 *    really do mean "this will stop and ask you".
 *  - the no-isolation pill is labelled with --fail rather than amber, because it
 *    is a hazard, not a request for attention. Its wording also departs from the
 *    mockup's "straight onto main", which named a branch that does not exist in
 *    two of the three cases it covers — CONTRACT.md Amendment 14.
 *
 * Commands go through `api()` so auth stays in one place, and state is read
 * through the shared store hooks — never a bespoke fetch or socket.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Aliased because the ⌘⏎ handler below listens on `window` and wants the DOM
// KeyboardEvent, not React's synthetic one. Two different types, one name.
import type {
  Agent,
  Autonomy,
  CreateJobResponse,
  EffortLevel,
  Isolation,
  Job,
  Project,
} from '@conductor/shared';
import { api } from '../lib/feed.js';
import { catalogLine, useModels } from '../lib/models.js';
import { ModelSelect } from '../shell/ui.js';
import { useCommand } from '../agent/endpoints.js';
import { removeProject } from './endpoints.js';
import { errorText } from '../lib/errors.js';
import { navigate, useNavParams } from '../lib/nav.js';
import type { ScreenDef } from '../lib/screens.js';
import { useProjects, useStatusBar } from '../lib/store.js';
import './spawn.css';

import {
  EFFORTS,
  MODES,
  PILLS,
  describeAutonomy,
  toAutonomy,
  type PillState,
} from './autonomy.js';
import {
  PRESETS,
  TIER_HINTS,
  commonPick,
  modelFor,
  personaOf,
  pickAll,
  pickFor,
  presetById,
  readsOnly,
  startsWhen,
  toAgentSpecs,
  unresolvedRoles,
  type PresetRole,
  type RoleModels,
} from './presets.js';
import { useIsRepo } from './browse.js';
import { HELPERS_MAX } from '@conductor/shared';
import { launchDefaults } from './defaults.js';
import { readSetting, useSetting, writeSetting } from '../lib/settings.js';
import {
  CUSTOM_ID,
  FIRST_ROLE,
  SETUPS_KEY,
  customProblems,
  parseSetups,
  personaPicks,
  toPreset,
  withSetup,
  withoutSetup,
  type CustomRole,
} from './custom.js';
import { CustomSetup } from './CustomSetup.js';
import { moveRow, rolesAbove, sameStack, toggleWait } from './order.js';
import { useReorder } from './reorder.js';
import { WaitsFor } from './RoleRow.js';
import { PERSONAS_KEY, personasFrom } from './personas.js';
import { useDraft } from '../lib/drafts.js';
import {
  CLAUDE,
  capabilitiesOf,
  controlsFor,
  offersMode,
  parseTokens,
  providerLabel,
  tokenWords,
  useProviderModels,
  useProviders,
} from '../lib/providers.js';
import { DEFAULT_BUDGET_TOKENS, autonomyOn, jobBudgetUsd, modeOn, specsOn, type EngineLaunch } from './engine.js';

const SCREEN_ID = 'spawn';

/**
 * One row of the "where" picker: select it, or drop it.
 *
 * REMOVAL LIVES HERE AS WELL AS ON THE FLEET CARD, and the duplication is the point
 * (Amendment 26). Amendment 25 consolidated it onto the Fleet card, which is right
 * for a project you are done with and wrong for the case that produces most
 * removals: a path you mistyped ten seconds ago, in the list you are looking at,
 * while setting up the job you came here for. Sending someone to another screen to
 * undo a typo made on this one is the same defect Amendment 17 was filed for.
 *
 * `×` is a sibling of the card, not a child: a button inside a button is invalid
 * HTML and browsers resolve it by dropping one of them.
 */
function PickerRow({
  project,
  selected,
  onSelect,
  onRemoved,
}: {
  project: Project;
  selected: boolean;
  onSelect: () => void;
  onRemoved: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const cmd = useCommand();

  if (armed) {
    return (
      <div className="sp-proj-cell">
        <div className="sp-proj-confirm">
          <p className="sp-cf-q">
            Remove <b>{project.name}</b>?
          </p>
          <p className="sp-cf-b">
            Conductor forgets it and its history. Nothing on your disk changes — the
            folder, any worktrees and every branch stay where they are.
          </p>
          <div className="sp-cf-row">
            <button
              type="button"
              className="sp-cf-go"
              disabled={cmd.busy}
              onClick={() =>
                void cmd.run('Removing the project', async () => {
                  const { removed } = await removeProject(project.id);
                  onRemoved();
                  return removed;
                })
              }
            >
              {cmd.busy ? 'removing…' : 'remove'}
            </button>
            <button
              type="button"
              className="sp-ghost"
              disabled={cmd.busy}
              onClick={() => {
                cmd.dismiss();
                setArmed(false);
              }}
            >
              cancel
            </button>
          </div>
          {/* A 409 means an agent in it is still running, and the daemon names which. */}
          {cmd.notice && (
            <div className={`sp-cf-note t-${cmd.notice.tone}`} onClick={cmd.dismiss}>
              {cmd.notice.text}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="sp-proj-cell">
      <button className="sp-proj" aria-pressed={selected} onClick={onSelect}>
        <div className="sp-proj-name">{project.name}</div>
        <div className="sp-proj-path">{project.path}</div>
      </button>
      <button
        type="button"
        className="sp-proj-x"
        title={`Remove ${project.name} from Conductor`}
        aria-label={`Remove ${project.name} from Conductor`}
        onClick={() => setArmed(true)}
      >
        ×
      </button>
    </div>
  );
}

interface IsolationDef {
  id: Isolation;
  label: string;
  note?: string;
  hint: string;
  danger?: boolean;
  /**
   * This isolation creates a branch, so it cannot run in a folder with no git.
   * Amendment 10 made that a real refusal in the daemon; without this flag the UI
   * offers it anyway and the user finds out from a 400 at launch, five decisions
   * after the one that caused it.
   */
  requiresGit?: boolean;
}

const ISOLATIONS: IsolationDef[] = [
  {
    id: 'worktree',
    label: 'new worktree',
    note: '.conductor/wt/<job>',
    hint: 'A separate checkout on its own branch. Your working tree is untouched.',
    requiresGit: true,
  },
  {
    id: 'branch',
    label: 'branch in place',
    hint: 'A new branch in this checkout. Agents and you share the same files.',
    requiresGit: true,
  },
  {
    id: 'in_place',
    label: 'this folder, as-is',
    note: 'no branch, no undo',
    hint:
      "Agents edit your files where they are — on whatever branch you're on, or no branch at all when the folder isn't a repo. The only isolation that needs no git, and the only one with nothing to revert to.",
    danger: true,
  },
];

function Spawn() {
  const projects = useProjects();
  const { slots } = useStatusBar();
  const params = useNavParams(SCREEN_ID);

  // Where every choice starts: the Settings tab's launch defaults (Amendment 47).
  const [start] = useState(() => launchDefaults(readSetting));
  // Outlives the screen: leaving Spawn or a reload keeps it (Amendment 64).
  const [prompt, setPrompt] = useDraft('spawn:prompt');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [isolation, setIsolation] = useState<Isolation>(start.isolation);
  const [presetId, setPresetId] = useState(start.preset);
  const [pills, setPills] = useState<PillState>(start.pills);
  const [budget, setBudget] = useState(start.budget);
  const [effort, setEffort] = useState<EffortLevel>(start.effort);
  /** How the agents interact with you, for the whole launch (Amendment 65). */
  const [mode, setMode] = useState<Autonomy['mode']>(start.mode);
  /** The exact id picked per role. A role with none keeps its preset's tier — the default. */
  const [ownPicks, setPicks] = useState<RoleModels>(() =>
    start.model ? pickAll(presetById(start.preset), start.model) : {},
  );
  const models = useModels();
  const tiers = useMemo(() => models.catalog?.tiers ?? {}, [models.catalog]);

  /*
   * The engine every agent of this launch runs on (Amendment 80): Claude unless you pick
   * another. Another engine has its own model list and, without dollars, a budget in
   * tokens; what it can't do isn't offered.
   */
  const providers = useProviders();
  const [provider, setProvider] = useState(CLAUDE);
  const claude = provider === CLAUDE;
  const caps = capabilitiesOf(provider, providers);
  const has = controlsFor(caps);
  const theirs = useProviderModels(claude ? null : provider);
  /** The one id a launch on another engine runs on: one it lists, or any typed. */
  const [engineModel, setEngineModel] = useState('');
  const [budgetTok, setBudgetTok] = useState(tokenWords(DEFAULT_BUDGET_TOKENS));
  const tokenParse = parseTokens(budgetTok);
  const tokenCap = 'cap' in tokenParse ? tokenParse.cap : null;
  const tokenWhy = !claude && !caps.costUsd && 'why' in tokenParse ? tokenParse.why : null;
  const launchOn = useMemo<EngineLaunch>(
    () => ({ provider, caps, model: engineModel.trim(), budgetTokens: tokenCap }),
    [provider, caps, engineModel, tokenCap],
  );
  /** Plan mode, on an engine without it, is sent — and shown — as "ask me". */
  const shownMode = modeOn(mode, caps);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [launched, setLaunched] = useState<CreateJobResponse | null>(null);
  // Two hint slots, not one. A single slot put section 3's explanation underneath
  // section 5, two sections from the pill being hovered — so the sentence that
  // says which isolation needs git was never read by the person choosing one.
  const [isoHint, setIsoHint] = useState('');
  const [hint, setHint] = useState('');

  // Deep link: `navigate('spawn', { projectId })` from a Fleet card's "+" pip.
  useEffect(() => {
    const wanted = params['projectId'];
    if (wanted && projects.some((p) => p.id === wanted)) setProjectId(wanted);
  }, [params, projects]);

  // Default to the only project there is, so the common case needs no click.
  useEffect(() => {
    if (projectId === null && projects.length === 1) setProjectId(projects[0]!.id);
  }, [projects, projectId]);

  // Custom setups (Amendment 50): the editor's rows, and the ones saved by name.
  const [custom, setCustom] = useState<CustomRole[]>([FIRST_ROLE]);
  /** Per role, the helpers it may start: several agents on one role (Amendment 51). */
  const [helpers, setHelpers] = useState<Record<string, number>>({});
  const [customName, setCustomName] = useState('');
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const saved = parseSetups(useSetting(SETUPS_KEY));
  /** Every persona, as Settings → Personas has them now (Amendment 68). */
  const personasRaw = useSetting(PERSONAS_KEY);
  const personas = useMemo(() => personasFrom(personasRaw), [personasRaw]);
  const isCustom = presetId === CUSTOM_ID;
  /*
   * This launch's changes to a preset's rows (Amendment 99): the order and who waits for
   * whom. Held here and nowhere else, so it is not stored and does not turn the preset into
   * a Custom setup; choosing a preset again, or the button in the plan, puts it back.
   */
  const [arranged, setArranged] = useState<{ presetId: string; roles: PresetRole[] } | null>(null);
  const base = presetById(presetId);
  const preset = isCustom
    ? toPreset(CUSTOM_ID, customName.trim() || 'custom', custom, personas)
    : arranged?.presetId === presetId
      ? { ...base, roles: arranged.roles }
      : base;
  /** Change a preset row's place or ticks for this launch; back to the preset's own is no change. */
  const arrange = (roles: PresetRole[]): void =>
    setArranged(sameStack(roles, base.roles) ? null : { presetId, roles });
  /** A preset's rows can be moved and ticked here; a Custom setup's are edited above, and one agent has no order. */
  const movable = !isCustom && preset.roles.length > 1;
  const reorder = useReorder((from, to) => arrange(moveRow(preset.roles, from, to)), preset.roles.length);
  /*
   * What each row is sent: your own pick, over the exact id a Custom row's persona names
   * (Amendment 68). A preset's row keeps its tier, so only a Custom setup has any.
   */
  const fromPersonas = useMemo<RoleModels>(() => (isCustom ? personaPicks(custom, personas) : {}), [isCustom, custom, personas]);
  const picks = useMemo<RoleModels>(() => ({ ...fromPersonas, ...ownPicks }), [fromPersonas, ownPicks]);
  /** A row's pick. Under a persona's id, the tier's id is a choice too, and the persona's is none. */
  const pickRow = (p: RoleModels, r: PresetRole, id: string): RoleModels => {
    const theirs = fromPersonas[r.role];
    if (!theirs) return pickFor(p, r, id, tiers);
    const next = { ...p };
    if (!id || id === theirs) delete next[r.role];
    else next[r.role] = id;
    return next;
  };
  const customBad = isCustom && customProblems(custom).length > 0;

  /*
   * Does the selected project have git in it?
   *
   * Asked here rather than discovered at launch. `worktree` and `branch` both create
   * a branch, so the daemon refuses them for a folder with no repo (Amendment 10) —
   * correctly, but with a 400 that arrives after the prompt is written, the preset is
   * chosen and the pills are set. The answer is known the moment a project is
   * selected, so the choice that cannot work is taken off the table there.
   *
   * `null` means not known yet, and is treated as "allowed": a slow answer must not
   * grey out two options, and if the daemon can't say, its own error is better than a
   * guess of ours.
   */
  const selected = projects.find((p) => p.id === projectId) ?? null;
  const isRepo = useIsRepo(selected?.path ?? null);
  const needsGit = isRepo === false;

  /*
   * Move off an isolation this project cannot run, and move back when it can.
   *
   * The `forced` ref is what makes the second half safe. Without it, choosing a
   * non-repo project and then a repo one would leave `in_place` selected — the one
   * isolation with nothing to revert to — because the user never chose it and has no
   * reason to look. Restoring only what we changed avoids overriding a deliberate
   * choice of `in_place` on a real repo.
   */
  const forced = useRef(false);
  useEffect(() => {
    if (needsGit && isolation !== 'in_place') {
      forced.current = true;
      setIsolation('in_place');
    } else if (isRepo === true && forced.current) {
      forced.current = false;
      setIsolation('worktree');
    }
  }, [needsGit, isRepo, isolation]);

  const budgetPerAgent = useMemo(() => {
    const n = Number(budget);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [budget]);

  // For Claude, autonomyOn and specsOn hand back what they are given: the launch is as before.
  const autonomy = useMemo(
    () => autonomyOn(toAutonomy(pills, budgetPerAgent, effort, mode), launchOn),
    [pills, budgetPerAgent, effort, mode, launchOn],
  );
  const specs = useMemo(
    () => specsOn(toAgentSpecs(preset, pills, budgetPerAgent, effort, picks, tiers, helpers, mode, personas), launchOn),
    [preset, pills, budgetPerAgent, effort, picks, tiers, helpers, mode, personas, launchOn],
  );
  /** The "every role" picker's value: the id every row runs on, or "" for per role. */
  const every = commonPick(preset, picks, tiers);
  /*
   * A tier the model API doesn't serve has no id to send. Launching anyway would hand
   * the daemon a nickname it refuses, so the launch waits until the list is read and
   * every row has an id — its tier's, or one picked for it.
   */
  const missing = claude ? unresolvedRoles(preset, tiers, picks) : [];
  // Another engine needs one id for the launch, and a token cap that parses.
  const engineReady =
    providers?.find((p) => p.id === provider)?.unavailable === null && launchOn.model !== '' && tokenWhy === null;
  const modelsReady = claude ? models.catalog !== null && missing.length === 0 : engineReady;

  /*
   * Picks belong to a preset's rows, so switching preset drops them — except one id
   * given to every row, which is a statement about the job rather than about a role.
   */
  const choosePreset = useCallback(
    (id: string) => {
      setPresetId(id);
      setArranged(null);
      setHelpers({});
      const next = id === CUSTOM_ID ? toPreset(CUSTOM_ID, 'custom', custom, personas) : presetById(id);
      setPicks(every ? pickAll(next, every) : {});
    },
    [every, custom, personas],
  );

  const free = Math.max(0, slots.total - slots.used);
  const willQueue = Math.max(0, specs.length - free);
  const canLaunch = prompt.trim().length > 0 && projectId !== null && !busy && modelsReady && !customBad;

  const launch = useCallback(async () => {
    if (!canLaunch || projectId === null) return;
    setBusy(true);
    setError(null);
    setLaunched(null);
    try {
      const result = await api<CreateJobResponse>('/api/jobs', {
        method: 'POST',
        body: {
          projectId,
          prompt: prompt.trim(),
          isolation,
          preset: preset.label,
          agents: specs,
          budgetUsd: jobBudgetUsd(budgetPerAgent, specs.length, caps),
        },
      });
      setLaunched(result);
      setPrompt('');
    } catch (err) {
      setError({ message: 'Launch failed', detail: errorText(err) });
    } finally {
      setBusy(false);
    }
  }, [canLaunch, projectId, prompt, isolation, preset.label, specs, budgetPerAgent, caps]);

  // ⌘⏎ / ctrl+⏎ launches from anywhere on the screen, per the mockup.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void launch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [launch]);

  const togglePill = (id: string): void =>
    setPills((prev) => ({ ...prev, [id]: !prev[id] }));

  return (
    <div className="sp-wrap">
      {/* ── 1 ─────────────────────────────────────────────────────────────── */}
      <div className="sp-section">
        <span className="sp-lab">1 · what needs doing</span>
        <textarea
          className="sp-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Rotate refresh tokens on every exchange and revoke the ancestor chain on reuse. Tests first."
          spellCheck={false}
        />
      </div>

      {/* ── 2 ─────────────────────────────────────────────────────────────── */}
      <div className="sp-section">
        <span className="sp-lab">2 · where</span>
        {/*
         * Pick one of the projects you have. Adding one is on Fleet (Amendment 45): this
         * step used to hold an add field under the list, which read as if it were asking
         * for the NEW project's folders, and it wasn't.
         */}
        {projects.length === 0 ? (
          <div className="sp-empty">
            No projects yet.
            <br />
            <button className="sp-link" onClick={() => navigate('fleet', { add: '1' })}>
              add the first one on Fleet
            </button>
          </div>
        ) : (
          <div className="sp-projects">
            {projects.map((p) => (
              <PickerRow
                key={p.id}
                project={p}
                selected={p.id === projectId}
                onSelect={() => setProjectId(p.id)}
                onRemoved={() => {
                  // The row is about to leave the snapshot. A `projectId` still
                  // pointing at it keeps `canLaunch` true and buys a 400 at launch.
                  if (projectId === p.id) setProjectId(null);
                }}
              />
            ))}
            <button
              className="sp-addproj"
              onClick={() => navigate('fleet', { add: '1' })}
              title="Adding a project — its main folder and the folders it references — is on Fleet"
            >
              + add a project on Fleet…
            </button>
          </div>
        )}
      </div>

      {/* ── 3 ─────────────────────────────────────────────────────────────── */}
      <div className="sp-section">
        <span className="sp-lab">3 · isolation</span>
        <div className="sp-pills">
          {ISOLATIONS.map((iso) => {
            const blocked = iso.requiresGit === true && needsGit;
            return (
              <button
                key={iso.id}
                className={`sp-pill${iso.danger ? ' sp-danger' : ''}`}
                aria-pressed={iso.id === isolation}
                disabled={blocked}
                onClick={() => setIsolation(iso.id)}
                onMouseEnter={() =>
                  setIsoHint(blocked ? 'Needs a git repository — this folder has none.' : iso.hint)
                }
                onMouseLeave={() => setIsoHint('')}
              >
                {iso.danger ? '⚠ ' : '⑂ '}
                {iso.label}
                {iso.note && <span className="sp-pill-note">{iso.note}</span>}
              </button>
            );
          })}
        </div>

        {/*
         * The sentence that would have saved a 400 at launch. Named after the folder,
         * not the mode, because "not a git repository" is a fact about the project the
         * user picked in step 2 and needs to be recognisable as one.
         */}
        {needsGit && selected && (
          <div className="sp-isonote">
            <b>{selected.name}</b> has no git in it, so only <b>this folder, as-is</b> can run
            here — the other two create a branch. Run <code>git init</code> in it if you want a
            worktree or a branch, and re-add it.
          </div>
        )}

        <div className="sp-hint">{isoHint}</div>
      </div>

      {/* ── 4 ─────────────────────────────────────────────────────────────── */}
      <div className="sp-section">
        <span className="sp-lab">4 · who works on it</span>
        <div className="sp-pills">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className="sp-pill"
              aria-pressed={p.id === presetId}
              onClick={() => choosePreset(p.id)}
            >
              {p.label}
            </button>
          ))}
          <button
            className="sp-pill"
            aria-pressed={isCustom && loadedFrom === null}
            title="Add the agents yourself, and pick each one's role and model"
            onClick={() => {
              choosePreset(CUSTOM_ID);
              setLoadedFrom(null);
            }}
          >
            custom…
          </button>
          {saved.map((s) => (
            <span key={s.name} className="sp-saved">
              <button
                className="sp-pill is-saved"
                aria-pressed={isCustom && loadedFrom === s.name}
                title={`Your saved setup: ${s.roles.map((r) => r.role).join(', ')}`}
                onClick={() => {
                  setPresetId(CUSTOM_ID);
                  setCustom(s.roles);
                  setCustomName(s.name);
                  setLoadedFrom(s.name);
                  setPicks(s.models);
                  setForgetting(null);
                }}
              >
                {s.name}
              </button>
              {forgetting === s.name ? (
                <button
                  className="sp-ghost"
                  onClick={() => {
                    writeSetting(SETUPS_KEY, withoutSetup(saved, s.name));
                    setForgetting(null);
                    if (loadedFrom === s.name) setLoadedFrom(null);
                  }}
                >
                  forget it
                </button>
              ) : (
                <button className="sp-ghost" aria-label={`Forget the saved setup ${s.name}`} onClick={() => setForgetting(s.name)}>
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
        {isCustom && (
          <CustomSetup
            roles={custom}
            onChange={(next) => {
              setCustom(next);
              // A renamed or removed row's pick goes with it.
              setPicks((p) => Object.fromEntries(Object.entries(p).filter(([role]) => next.some((r) => r.role === role))));
            }}
            name={customName}
            onName={setCustomName}
            saved={saved.some((s) => s.name === customName.trim())}
            personas={personas}
            onSave={() => {
              const name = customName.trim();
              // Your own picks only: a persona's model is the persona's, read at launch (Amendment 68).
              writeSetting(SETUPS_KEY, withSetup(saved, { name, roles: custom, models: ownPicks }));
              setLoadedFrom(name);
            }}
          />
        )}

        {/*
         * The model, per row, with this as the shortcut for all of them. A preset assigns
         * one per role deliberately — opus where something is judged, sonnet where a
         * decided plan is executed — so the default is "leave that alone". Each row of the
         * plan below has its own picker; this one sets every row at once, and "per role"
         * puts every row back on its preset's tier. (Amendment 41)
         */}
        {/*
         * The engine (Amendment 80). Only once the daemon has said which it has: a daemon
         * from before has only Claude, and nothing to choose. One that can't launch agents
         * is shown, off, with the daemon's reason under it.
         */}
        {providers && providers.length > 1 && (
          <>
            <div className="sp-efforts" role="radiogroup" aria-label="The engine the agents run on">
              <span className="ui-lab">engine</span>
              {[CLAUDE, ...providers.map((p) => p.id).filter((id) => id !== CLAUDE)].map((id) => {
                const why = providers.find((p) => p.id === id)?.unavailable ?? null;
                return (
                  <button
                    key={id}
                    role="radio"
                    className="sp-pill is-tight"
                    aria-checked={provider === id}
                    aria-pressed={provider === id}
                    disabled={id !== CLAUDE && why !== null}
                    title={why ?? undefined}
                    onClick={() => {
                      setProvider(id);
                      setEngineModel('');
                    }}
                  >
                    {providerLabel(id)}
                  </button>
                );
              })}
            </div>
            {providers
              .filter((p) => p.id !== CLAUDE && p.unavailable !== null)
              .map((p) => (
                <div key={p.id} className="sp-provnote">
                  {providerLabel(p.id)}: {p.unavailable}
                </div>
              ))}
          </>
        )}
        {claude ? (
        <div className="sp-efforts">
          <span className="ui-lab">model</span>
          <ModelSelect
            catalog={models.catalog}
            value={every ?? ''}
            none="per role"
            onChange={(id) => setPicks(pickAll(preset, id))}
            onRefresh={models.refresh}
            loading={models.loading}
            title={
              every
                ? `Every role runs on ${every}.`
                : 'Each role runs on the model in its row below — its preset tier unless you pick another.'
            }
          />
        </div>
        ) : (
          /*
           * One id for every agent of the launch. Ids here are free-form
           * (`anthropic/claude-sonnet-4.5`), so it is a field: what the engine lists is
           * offered, and any id can be typed. The daemon checks it against the same list.
           */
          <div className="sp-efforts">
            <span className="ui-lab">model</span>
            <span className="ui-model">
              <input
                className="sp-input sp-engmodel"
                list="sp-engine-models"
                value={engineModel}
                spellCheck={false}
                placeholder={theirs.list?.models[0]?.id ?? 'a model id'}
                aria-label={`Model id on ${providerLabel(provider)}`}
                onChange={(e) => setEngineModel(e.target.value)}
              />
              <datalist id="sp-engine-models">
                {(theirs.list?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName === m.id ? '' : m.displayName}
                  </option>
                ))}
              </datalist>
              <button
                type="button"
                className="ui-refresh"
                onClick={theirs.refresh}
                disabled={theirs.loading}
                title={`Ask ${providerLabel(provider)} again for what it lists`}
                aria-label="Refresh the model list"
              >
                {theirs.loading ? '…' : '↻'}
              </button>
            </span>
          </div>
        )}
        {claude && models.error && (
          <div className="sp-cf-note t-fail is-still">Could not read the model list — {models.error}</div>
        )}
        {claude && !models.error && catalogLine(models.catalog) && (
          <div className="sp-cf-note t-warn is-still">{catalogLine(models.catalog)}</div>
        )}
        {!claude && theirs.error && (
          <div className="sp-cf-note t-fail is-still">
            Could not read {providerLabel(provider)}’s model list — {theirs.error}. Type an id.
          </div>
        )}
        {!claude && theirs.list?.note && (
          <div className="sp-cf-note t-warn is-still">
            {theirs.list.note}
            {theirs.list.models.length === 0 ? ' — type an id.' : ''}
          </div>
        )}
        {missing.length > 0 && models.catalog && (
          <div className="sp-cf-note t-fail is-still">
            {models.catalog.host ?? 'The model API'} serves no{' '}
            {[...new Set(missing.map((r) => r.model))].join(' or ')} model, which this preset
            gives {missing.map((r) => r.role).join(', ')} — pick{' '}
            {missing.length === 1 ? 'one in its row' : 'one in each of those rows'} below.
          </div>
        )}

        <div className="sp-plan">
          <div className="sp-plan-head">
            <span className="sp-lab">
              Will launch {preset.roles.length} agent{preset.roles.length === 1 ? '' : 's'}
            </span>
            {/*
             * A preset's rows move and take ticks for this launch (Amendment 99); a Custom
             * setup's are edited above, where they are saved. Either way, a row's place sets
             * what it may wait for: only rows above it.
             */}
            {movable && (
              <span className="sp-plan-note">
                move a row (⋮⋮ or ↑ ↓) or tick what it waits for — for this launch only
              </span>
            )}
            {movable && arranged?.presetId === presetId && (
              <button
                type="button"
                className="sp-ghost sp-plan-reset"
                title={`Put ${base.label} back as it is: its order, and who waits for whom`}
                onClick={() => setArranged(null)}
              >
                ↺ back to {base.label}
              </button>
            )}
          </div>
          <div className="sp-plan-body" ref={reorder.rootRef} {...reorder.rootProps}>
            {preset.roles.map((r, i) => {
              const persona = personaOf(r, personas);
              return (
              <div
                className={`sp-areorder${movable ? ` sp-reorder${reorder.markOf(i)}` : ''}`}
                key={r.role}
                {...(movable ? reorder.rowProps(i) : {})}
              >
                <div className="sp-arow">
                  {movable && reorder.handle(i, r.role)}
                  <i className="sp-dot" />
                  <span className="sp-role">{r.role}</span>
                  {/* A row named apart from its persona says which it is (Amendment 68). */}
                  {persona && persona.name !== r.role && (
                    <span className="sp-persona" title={persona.description || undefined}>
                      {persona.name}
                    </span>
                  )}
                  <span className="sp-does">{r.does}</span>
                  {/*
                   * The id this row will be sent, and the place to change it. Unpicked, it
                   * shows what the preset's tier means now; a tier with nothing served
                   * shows as an empty choice, which is what blocks the launch.
                   */}
                  <span className="sp-model">
                    {!claude ? (
                      <span title={`Every agent of this launch runs on ${providerLabel(provider)}`}>
                        {launchOn.model || 'pick a model above'}
                      </span>
                    ) : (
                    <ModelSelect
                      catalog={models.catalog}
                      value={modelFor(r, picks, tiers) ?? ''}
                      {...(modelFor(r, picks, tiers)
                        ? {}
                        : { none: models.catalog ? `${r.model} · not served` : `${r.model} · reading…` })}
                      onChange={(id) => setPicks((p) => pickRow(p, r, id))}
                      disabled={!models.catalog}
                      title={
                        ownPicks[r.role]
                          ? `Picked for ${r.role}. Its preset gives it ${r.model} — ${TIER_HINTS[r.model]}`
                          : picks[r.role]
                            ? `${persona?.name ?? r.role}'s model. Pick another for this launch.`
                            : `The preset's ${r.model} tier — ${TIER_HINTS[r.model]}`
                      }
                    />
                    )}
                  </span>
                  {/*
                   * The pills below describe the job; a reading role overrides them
                   * and is denied the write tools outright. Saying so here is the
                   * point of this screen — the resolved-options block at the bottom
                   * shows the job's autonomy, which for this row is not what gets
                   * sent.
                   */}
                  {readsOnly(r, personas) && <span className="sp-ro">read-only</span>}
                  {/*
                   * Several agents on this role (Amendment 51): this one orchestrates — splits
                   * the work, starts helpers with its own model and permissions, and hears
                   * what they report. Each helper takes a slot and a per-agent budget.
                   */}
                  {has.helpers && (
                  <select
                    className="ui-select sp-helpers"
                    value={helpers[r.role] ?? 0}
                    title="Put several agents on this role: this one splits the work, starts up to this many helpers, and hears what they report. Each helper takes a slot and its own budget."
                    onChange={(e) => setHelpers((h) => ({ ...h, [r.role]: Number(e.target.value) }))}
                  >
                    <option value={0}>1 agent</option>
                    {Array.from({ length: HELPERS_MAX }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        + up to {n} helper{n === 1 ? '' : 's'}
                      </option>
                    ))}
                  </select>
                  )}
                  <span className="sp-when">{startsWhen(r)}</span>
                </div>
                {movable && i > 0 && (
                  <div className="sp-awaits">
                    <WaitsFor
                      who={r.role}
                      options={rolesAbove(preset.roles, i)}
                      waits={r.dependsOnRoles ?? []}
                      onToggle={(on) => arrange(toggleWait(preset.roles, i, on))}
                    />
                  </div>
                )}
              </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── 5 ─────────────────────────────────────────────────────────────── */}
      <div className="sp-section">
        <span className="sp-lab">5 · how much rope</span>
        {/*
         * How the agents interact with you (Amendment 65): one choice, the SDK's permission
         * mode. The pills below keep the tool rules, which hold in every mode.
         */}
        <div className="sp-pills sp-modes" role="radiogroup" aria-label="How the agents interact with you">
          {MODES.filter((m) => offersMode(m.id, caps)).map((m) => (
            <button
              key={m.id}
              role="radio"
              className={`sp-pill${m.warn ? ' sp-danger' : ''}`}
              aria-checked={shownMode === m.id}
              aria-pressed={shownMode === m.id}
              onClick={() => setMode(m.id)}
              onMouseEnter={() => setHint(m.hint)}
              onMouseLeave={() => setHint('')}
            >
              {m.warn ? '⚠ ' : ''}
              {m.label}
            </button>
          ))}
        </div>
        {MODES.find((m) => m.id === shownMode)?.warn && (
          <div className="sp-isonote sp-warnmode">{MODES.find((m) => m.id === shownMode)!.warn}</div>
        )}
        {/*
         * Every pill reads the same way: ON MEANS THE AGENT MAY DO IT. The ⚠ follows the
         * state rather than the pill, so it marks the setting that will actually stop and
         * ask you — which is the only thing that glyph is allowed to mean.
         */}
        <div className="sp-pills">
          {PILLS.map((p) => {
            const on = pills[p.id] === true;
            const warns = p.interruptsWhenOff === true && !on;
            return (
              <button
                key={p.id}
                className={`sp-pill${warns ? ' sp-interrupts' : ''}`}
                aria-pressed={on}
                onClick={() => togglePill(p.id)}
                onMouseEnter={() => setHint(p.hint)}
                onMouseLeave={() => setHint('')}
              >
                {warns ? '⚠ ' : ''}
                {p.label}
              </button>
            );
          })}
          {has.budget === 'usd' ? (
          <span className="sp-pill" aria-pressed={budgetPerAgent !== null}>
            ⏱ stop each agent after $
            <input
              className="sp-input"
              style={{ width: '3.6em', marginLeft: 4, padding: '1px 5px' }}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
            />
          </span>
          ) : (
            /* No dollars from this engine, so its cap is tokens, input plus output (Amendment 77). */
            <span className="sp-pill" aria-pressed={tokenCap !== null}>
              ⏱ stop each agent after
              <input
                className="sp-input"
                style={{ width: '4.2em', marginLeft: 4, marginRight: 4, padding: '1px 5px' }}
                value={budgetTok}
                onChange={(e) => setBudgetTok(e.target.value)}
                aria-label="Tokens per agent, input plus output. Empty for no cap."
              />
              tokens
            </span>
          )}
        </div>
        {tokenWhy && <div className="sp-cf-note t-fail is-still">{tokenWhy}</div>}

        {/*
         * Effort is not rope — it buys thinking, not permission — so it gets its own row
         * rather than a pill in a list that otherwise means "is the agent allowed to".
         */}
        {has.effort && (
        <div className="sp-efforts">
          <span className="ui-lab">effort</span>
          {EFFORTS.map((e) => (
            <button
              key={e.id}
              className={`sp-pill is-tight${e.id === effort ? '' : ''}`}
              aria-pressed={e.id === effort}
              onClick={() => setEffort(e.id)}
              onMouseEnter={() => setHint(e.hint)}
              onMouseLeave={() => setHint('')}
            >
              {e.label}
            </button>
          ))}
        </div>
        )}

        <div className="sp-hint">{hint}</div>

        {/* No hidden translation: show exactly what the daemon will be sent. */}
        <details className="sp-resolved">
          <summary>resulting SDK options — {describeAutonomy(autonomy)}</summary>
          <div>
            permissionMode <code>{autonomy.mode}</code>
            <br />
            allowedTools <code>[{autonomy.allowedTools.join(', ')}]</code>
            <br />
            disallowedTools <code>[{autonomy.disallowedTools.join(', ') || '—'}]</code>
            <br />
            {!claude && (
              <>
                provider <code>{provider}</code> · model <code>{launchOn.model || '—'}</code>
                <br />
              </>
            )}
            {has.effort && (
              <>
                effort <code>{autonomy.effort ?? 'sdk default'}</code>
                <br />
              </>
            )}
            {has.budget === 'usd' ? (
              <>
                budget per agent <code>{autonomy.budgetUsd === null ? 'uncapped' : `$${autonomy.budgetUsd}`}</code>
              </>
            ) : (
              <>
                budget per agent{' '}
                <code>{autonomy.budgetTokens ? `${tokenWords(autonomy.budgetTokens)} tokens` : 'uncapped'}</code>
              </>
            )}
            <br />
            <span style={{ color: 'var(--ink3)' }}>
              tools absent from allowedTools are the ones that will ask you
            </span>
          </div>
        </details>
      </div>

      {/* ── launch ────────────────────────────────────────────────────────── */}
      <div className="sp-launch">
        <button className="sp-go" onClick={() => void launch()} disabled={!canLaunch}>
          {busy
            ? 'launching…'
            : claude && !models.catalog && !models.error
              ? 'reading models…'
              : !claude && launchOn.model === ''
                ? 'pick a model'
                : `launch ${specs.length} agent${specs.length === 1 ? '' : 's'}`}
          <span className="sp-kbd">⌘⏎</span>
        </button>
        {/* "plan first" was a button here; it is one of the modes now (Amendment 65). */}
        <span className="sp-slots">
          {free} of {slots.total} slot{free === 1 ? '' : 's'} free
          {willQueue > 0 && ` · ${willQueue} will stay queued`}
        </span>
      </div>

      {error && (
        <div className="sp-error">
          {error.message}
          {error.detail && <code>{error.detail}</code>}
        </div>
      )}

      {launched && <Launched result={launched} />}
    </div>
  );
}

/**
 * What just happened, and the way into it.
 *
 * Not an auto-jump: the Agent screen belongs to Track B and is not in this tree
 * yet, so navigating away on launch would land the user on nothing. An explicit
 * button uses Amendment 3's navigate() and starts working the moment Track B
 * merges, while the launch result stays visible either way.
 */
function Launched({ result }: { result: CreateJobResponse }) {
  const { job, agents } = result;
  return (
    <div className="sp-done">
      <div className="sp-done-title">
        Launched {agents.length} agent{agents.length === 1 ? '' : 's'} · {job.isolation} ·{' '}
        <span className="sp-model">{job.branch}</span>
      </div>
      {agents.map((a: Agent) => (
        <div className="sp-done-row" key={a.id}>
          <i className="sp-dot" />
          <span className="sp-role">{a.role}</span>
          <span className="sp-does">{a.status}</span>
          <button className="sp-link" onClick={() => navigate('agent', { agentId: a.id })}>
            watch →
          </button>
        </div>
      ))}
      <div className="sp-done-row">
        <span className="sp-when">{describeJob(job)}</span>
      </div>
    </div>
  );
}

function describeJob(job: Job): string {
  return `${job.worktreePath}${job.budgetUsd === null ? '' : ` · capped at $${job.budgetUsd}`}`;
}

export const screen: ScreenDef = {
  id: SCREEN_ID,
  label: 'Spawn',
  // Reached from a project — the projects panel's "+" and Fleet's — not from the top
  // menu. (Amendment 42)
  tab: false,
  order: 70,
  Component: Spawn,
};
