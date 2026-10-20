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
  BranchesResponse,
  CreateJobResponse,
  CreateJobsResponse,
  EffortLevel,
  Job,
  Project,
} from '@conductor/shared';
import { api } from '../lib/feed.js';
import { catalogLine, useModels } from '../lib/models.js';
import { ModelSelect, OrchestratorMark } from '../shell/ui.js';
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
  orchestratedFor,
  personaOf,
  pickAll,
  pickFor,
  presetById,
  readsOnly,
  rowOverrides,
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
  KNOWN_ROLES,
  SETUPS_KEY,
  customProblems,
  orchestratorRow,
  parseSetups,
  personaPicks,
  renameSetup,
  roleFromName,
  rowPersona,
  setupOf,
  toPreset,
  untouchedRole,
  withSetup,
  withoutSetup,
  type CustomRole,
  type SavedSetup,
} from './custom.js';
import { CustomSetup } from './CustomSetup.js';
import { moveRow, rolesAbove, sameStack, toggleWait } from './order.js';
import { Pipeline } from './Pipeline.js';
import { defaultListed, helperCapFor, helpersInAll, orchestrates, unresolvedListed, type ListedRole } from './orchestrated.js';
import {
  METHODS,
  STACKS_KEY,
  branchOptions,
  branchProblem,
  launchRequest,
  methodReady,
  pickedNote,
  presetLabel,
  stacksBudgetLine,
  stacksFrom,
  stacksNotes,
  stacksPreview,
  stacksRefusal,
  type Method,
} from './launch.js';
import { getBranches } from '../branches/endpoints.js';
import { useReorder } from './reorder.js';
import { RoleRow, WaitsFor } from './RoleRow.js';
import { PERSONAS_KEY, personaFor, personasFrom } from './personas.js';
import { SINGLE_ID, asRow, parseSingle, singleKey, singlePreset, singleProblems, singleSetting, type SinglePick } from './single.js';
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

function SavedStackName({
  setup,
  saved,
  onSaved,
  onCancel,
}: {
  setup: SavedSetup;
  saved: SavedSetup[];
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(setup.name);
  const [problem, setProblem] = useState<string | null>(null);

  const save = (): void => {
    try {
      const next = name.trim();
      if (next === setup.name) return onCancel();
      writeSetting(SETUPS_KEY, renameSetup(saved, setup.name, next));
      onSaved(next);
    } catch (err) {
      setProblem(errorText(err));
    }
  };

  return (
    <form
      className="sp-saved-rename"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key !== 'Escape') return;
        e.preventDefault();
        onCancel();
      }}
    >
      <input
        className="sp-input"
        value={name}
        autoFocus
        maxLength={60}
        spellCheck={false}
        aria-label={`Rename saved stack ${setup.name}`}
        aria-invalid={problem !== null}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          setName(e.target.value);
          setProblem(null);
        }}
      />
      <button type="submit" className="sp-ghost">save</button>
      <button type="button" className="sp-ghost" onClick={onCancel}>cancel</button>
      {problem && <span className="sp-saved-problem">{problem}</span>}
    </form>
  );
}

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

function Spawn() {
  const projects = useProjects();
  const { slots } = useStatusBar();
  const params = useNavParams(SCREEN_ID);

  // Where every choice starts: the Settings tab's launch defaults (Amendment 47).
  const [start] = useState(() => launchDefaults(readSetting));
  // Outlives the screen: leaving Spawn or a reload keeps it (Amendment 64).
  const [prompt, setPrompt] = useDraft('spawn:prompt');
  const [projectId, setProjectId] = useState<string | null>(null);
  /** Which git methodology this launch uses (Amendment 115), and (2)'s branch name. */
  const [method, setMethod] = useState<Method>(start.method);
  const [branchName, setBranchName] = useState('');
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
  /** The stacks a batch launch started, or each one's reason (Amendment 181); null after one stack. */
  const [launchedStacks, setLaunchedStacks] = useState<CreateJobsResponse | null>(null);
  /**
   * How many stacks this launch starts from one plan (Amendment 181): state of this launch, as a
   * preset's edits are (Amendment 99), and back to 1 after it and when you choose a preset.
   */
  const [stacksAsked, setStacks] = useState(1);
  const stacksMax = stacksFrom(useSetting(STACKS_KEY));
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
  /** An orchestrated stack's listed roles, once you change them; null is the default list (Amendment 128). */
  const [listedEdit, setListedEdit] = useState<ListedRole[] | null>(null);
  /**
   * Its helpers in all, once you choose; null is `helperCapFor` the list (Amendment 151). Kept for
   * this launch as the per-role helpers are, and put back when you choose a preset.
   */
  const [pipeHelpers, setPipeHelpers] = useState<number | null>(null);
  const [customName, setCustomName] = useState('');
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [renamingSetup, setRenamingSetup] = useState<string | null>(null);
  const saved = parseSetups(useSetting(SETUPS_KEY));
  /** Every persona, as Settings → Personas has them now (Amendment 68). */
  const personasRaw = useSetting(PERSONAS_KEY);
  const personas = useMemo(() => personasFrom(personasRaw), [personasRaw]);
  const isCustom = presetId === CUSTOM_ID;
  /*
   * What "one agent" launches (Amendment 179): the role and persona last picked for this
   * project, else a developer. An edit is held here as typed and stored once it can launch, so
   * a role half typed doesn't snap back to the stored one.
   */
  const storedSingle = parseSingle(useSetting(projectId ? singleKey(projectId) : ''), personas);
  const [singleEdit, setSingleEdit] = useState<{ projectId: string | null; pick: SinglePick } | null>(null);
  const singlePick = singleEdit && singleEdit.projectId === projectId ? singleEdit.pick : storedSingle;
  const chooseSingle = (next: SinglePick): void => {
    setSingleEdit({ projectId, pick: next });
    if (projectId && singleProblems(next).length === 0) writeSetting(singleKey(projectId), singleSetting(next));
  };
  /* As a Custom row does: picking a persona names the agent after it, unless it was named by hand. */
  const pickSinglePersona = (id: string): void => {
    const next = id ? personaFor(personas, id) : undefined;
    const untouched = untouchedRole(singlePick.role, rowPersona(asRow(singlePick), personas), personas);
    chooseSingle({ role: next && untouched ? roleFromName(next.name) : singlePick.role, persona: id });
  };
  const singleBad = presetId === SINGLE_ID && singleProblems(singlePick).length > 0;
  /*
   * This launch's changes to a preset's rows (Amendment 99): the order and who waits for
   * whom. Held here and nowhere else, so it is not stored and does not turn the preset into
   * a Custom setup; choosing a preset again, or the button in the plan, puts it back.
   */
  const [arranged, setArranged] = useState<{ presetId: string; roles: PresetRole[] } | null>(null);
  const base = presetId === SINGLE_ID ? singlePreset(singlePick) : presetById(presetId);
  /*
   * An orchestrated pipeline's roles (Amendment 128): the default list until you change it, and
   * none on an engine that cannot start helpers. With none the stack is one agent, so the
   * orchestrator row becomes a plain architect and nothing says it orchestrates (`orchestratedFor`).
   */
  const listed: readonly ListedRole[] = has.helpers ? (listedEdit ?? defaultListed(personas)) : [];
  const inAll = helpersInAll(listed, pipeHelpers);
  const ownRows = isCustom
    ? toPreset(CUSTOM_ID, customName.trim() || 'custom', custom, personas)
    : arranged?.presetId === presetId
      ? { ...base, roles: arranged.roles }
      : base;
  const preset = orchestratedFor(ownRows, listed);
  /*
   * The row the roles are listed under: the orchestrated preset's one row, or the Custom row
   * that orchestrates (Amendment 142, custom.ts `orchestrates`), whether or not any role is left,
   * so the list stays editable when it is one agent. None on an engine that cannot start helpers.
   */
  const listsUnder: string | null = !has.helpers
    ? null
    : isCustom
      ? (orchestratorRow(custom)?.role ?? null)
      : base.orchestrated === true
        ? (preset.roles[0]?.role ?? null)
        : null;
  const listsRoles = listsUnder !== null;
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
   * Move off a method this project cannot run, and move back when it can.
   *
   * The `forced` ref is what makes the second half safe. Without it, choosing a
   * non-repo project and then a repo one would leave `in_place` selected — the one
   * choice with nothing to revert to — because the user never chose it and has no
   * reason to look. It holds what the user had, and restores that, only when we were the
   * ones who changed it: a deliberate choice of `in_place` on a real repo is left alone.
   */
  const forced = useRef<Method | null>(null);
  useEffect(() => {
    if (needsGit && method !== 'in_place') {
      forced.current = method;
      setMethod('in_place');
    } else if (isRepo === true && forced.current !== null) {
      const back = forced.current;
      forced.current = null;
      setMethod(back);
    }
  }, [needsGit, isRepo, method]);

  /*
   * (2) needs a name git will take, and the project's default branch is not one. The daemon
   * has the last word (a branch checked out elsewhere is only known there); this spares the
   * round trip for the rest.
   */
  const refused = useMemo(() => (selected ? [selected.defaultBranch] : []), [selected]);
  const methodOk = methodReady(method, branchName, refused);
  const nameProblem = method === 'named' && branchName.trim() !== '' ? branchProblem(branchName, refused) : null;

  /*
   * (2)'s picker (Amendment 139): the project's branches, fetched when (2) is chosen and
   * again when the project changes, local ones first and then those only on origin. A
   * failed fetch leaves the field as it was, free text with nothing listed.
   */
  const [branchList, setBranchList] = useState<BranchesResponse | null>(null);
  const wantsBranches = method === 'named' && projectId !== null && isRepo !== false;
  useEffect(() => {
    setBranchList(null);
    if (!wantsBranches || projectId === null) return;
    let live = true;
    getBranches(projectId).then(
      (res) => {
        if (live) setBranchList(res);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wantsBranches, projectId]);
  const branchPicks = useMemo(() => branchOptions(branchList, refused), [branchList, refused]);
  const branchNote = method === 'named' ? pickedNote(branchName, branchPicks) : null;

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
    () => specsOn(toAgentSpecs(preset, pills, budgetPerAgent, effort, picks, tiers, helpers, mode, personas, listed, inAll), launchOn),
    [preset, pills, budgetPerAgent, effort, picks, tiers, helpers, mode, personas, listed, inAll, launchOn],
  );
  /** The "every role" picker's value: the id every row runs on, or "" for per role. */
  const every = commonPick(preset, picks, tiers);
  /*
   * A tier the model API doesn't serve has no id to send. Launching anyway would hand
   * the daemon a nickname it refuses, so the launch waits until the list is read and
   * every row has an id — its tier's, or one picked for it.
   */
  const missing = claude ? unresolvedRoles(preset, tiers, picks) : [];
  // The same for the roles an orchestrator may start (Amendment 128): each needs a model its tier means.
  const missingListed = claude && preset.roles.some((r) => r.orchestrates) ? unresolvedListed(listed, tiers) : [];
  // Another engine needs one id for the launch, and a token cap that parses.
  const engineReady =
    providers?.find((p) => p.id === provider)?.unavailable === null && launchOn.model !== '' && tokenWhy === null;
  const modelsReady = claude ? models.catalog !== null && missing.length === 0 && missingListed.length === 0 : engineReady;

  /*
   * Picks belong to a preset's rows, so switching preset drops them — except one id
   * given to every row, which is a statement about the job rather than about a role.
   */
  const choosePreset = useCallback(
    (id: string) => {
      setPresetId(id);
      setArranged(null);
      setHelpers({});
      setListedEdit(null);
      setPipeHelpers(null);
      setStacks(1);
      const next =
        id === CUSTOM_ID ? toPreset(CUSTOM_ID, 'custom', custom, personas) : id === SINGLE_ID ? singlePreset(singlePick) : presetById(id);
      setPicks(every ? pickAll(next, every) : {});
    },
    [every, custom, personas, singlePick],
  );

  /*
   * One agent's model pick follows its role (Amendment 179): renaming it, or a project that
   * remembers another, keeps the id picked rather than dropping it.
   */
  useEffect(() => {
    if (presetId !== SINGLE_ID) return;
    setPicks((p) => {
      const ids = Object.entries(p);
      if (ids.length === 0 || (ids.length === 1 && ids[0]![0] === singlePick.role)) return p;
      const id = ids[0]![1];
      return id ? { [singlePick.role]: id } : {};
    });
  }, [presetId, singlePick.role]);

  /*
   * Stacks (Amendment 181), offered where the roles are listed and something orchestrates: one
   * otherwise, and never more than the setting lets the daemon take now.
   */
  const stacked = listsRoles && orchestrates(listed);
  const stacks = stacked ? Math.min(stacksAsked, stacksMax) : 1;
  const stacksWhy = stacksRefusal(prompt, method, branchName, stacks, stacksMax);
  const jobBudget = jobBudgetUsd(budgetPerAgent, specs.length, caps);

  const free = Math.max(0, slots.total - slots.used);
  const willQueue = Math.max(0, specs.length * stacks - free);
  const canLaunch =
    prompt.trim().length > 0 && projectId !== null && !busy && modelsReady && !customBad && !singleBad && methodOk && stacksWhy === null;
  /** This launch's rows are not the preset's own, so its label says so (Amendment 115). */
  const changed = !isCustom && !sameStack(preset.roles, base.roles);

  const launch = useCallback(async () => {
    if (!canLaunch || projectId === null) return;
    setBusy(true);
    setError(null);
    setLaunched(null);
    setLaunchedStacks(null);
    try {
      const request = launchRequest(
        {
          projectId,
          prompt,
          method,
          branch: branchName,
          preset: presetLabel(preset.label, changed),
          agents: specs,
          budgetUsd: jobBudget,
        },
        stacks,
      );
      // One stack posts what a launch always posted; more go as one batch, 201 or 207 (Amendment 181).
      if (request.path === '/api/jobs') {
        setLaunched(await api<CreateJobResponse>(request.path, { method: 'POST', body: request.body }));
      } else {
        setLaunchedStacks(await api<CreateJobsResponse>(request.path, { method: 'POST', body: request.body }));
      }
      setStacks(1);
      setPrompt('');
      // The branch is taken now, by the job just launched: naming it again would be a 409.
      if (method === 'named') setBranchName('');
    } catch (err) {
      setError({ message: 'Launch failed', detail: errorText(err) });
    } finally {
      setBusy(false);
    }
  }, [canLaunch, projectId, prompt, method, branchName, preset.label, changed, specs, jobBudget, stacks]);

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
        {/* Each stack's first line, its number filled in (Amendment 181), and why it can't launch. */}
        {stacks > 1 && (
          <div className="sp-stack-lines" aria-label="Each stack's first line">
            {stacksPreview(prompt, stacks).map((line, i) => (
              <div key={i}>
                {i + 1} · {line}
              </div>
            ))}
          </div>
        )}
        {stacksWhy && <div className="sp-cf-note t-fail is-still">{stacksWhy}</div>}
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
        <span className="sp-lab">3 · git — which branch the agents work on</span>
        {/*
         * Three methodologies (Amendment 115), not three isolations: the folder on what's
         * checked out, a branch you name, or a new one per launch. The old in-place
         * branch isolation is not offered any more; the daemon still accepts it.
         */}
        <div className="sp-pills">
          {METHODS.map((m, i) => {
            const blocked = m.requiresGit === true && needsGit;
            return (
              <button
                key={m.id}
                className={`sp-pill${m.danger ? ' sp-danger' : ''}`}
                aria-pressed={m.id === method}
                disabled={blocked}
                onClick={() => setMethod(m.id)}
                onMouseEnter={() =>
                  setIsoHint(blocked ? 'Needs a git repository — this folder has none.' : m.hint)
                }
                onMouseLeave={() => setIsoHint('')}
              >
                {m.danger ? '⚠ ' : '⑂ '}
                {i + 1} · {m.label}
                {m.note && <span className="sp-pill-note">{m.note}</span>}
              </button>
            );
          })}
        </div>

        {method === 'named' && (
          <div className="sp-branchrow">
            <label className="sp-branchlab" htmlFor="sp-branch">branch</label>
            <input
              id="sp-branch"
              className="sp-input sp-branch"
              value={branchName}
              onChange={(e) => setBranchName(e.target.value)}
              placeholder="feature/refresh-tokens"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-invalid={nameProblem !== null}
              aria-describedby="sp-branch-note"
              list="sp-branch-list"
            />
            {/*
             * Still free text (Amendment 139): the list only offers what is there. A branch
             * a named launch refuses is listed with why, so you can see it is taken.
             */}
            <datalist id="sp-branch-list">
              {branchPicks.map((o) => (
                <option key={`${o.from}:${o.value}`} value={o.value} label={o.label} />
              ))}
            </datalist>
            <span
              id="sp-branch-note"
              className={`sp-branchnote${nameProblem || branchPicks.some((o) => o.refused && o.value === branchName.trim()) ? ' is-bad' : ''}`}
            >
              {nameProblem ??
                branchNote ??
                (branchName.trim() === ''
                  ? `Name the branch to launch, or pick one${branchPicks.length > 0 ? ` of ${branchPicks.length}` : ''}. One that exists is used as it is; one only on origin is tracked; a new one is cut from what the folder has checked out.`
                  : 'In its own worktree. One that exists is used as it is, with its commits.')}
            </span>
          </div>
        )}

        {/*
         * The sentence that would have saved a 400 at launch. Named after the folder,
         * not the mode, because "not a git repository" is a fact about the project the
         * user picked in step 2 and needs to be recognisable as one.
         */}
        {needsGit && selected && (
          <div className="sp-isonote">
            <b>{selected.name}</b> has no git in it, so only <b>default branch</b> can run
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
          {saved.map((s) => renamingSetup === s.name ? (
            <SavedStackName
              key={s.name}
              setup={s}
              saved={saved}
              onCancel={() => setRenamingSetup(null)}
              onSaved={(name) => {
                if (loadedFrom === s.name) {
                  setLoadedFrom(name);
                  setCustomName(name);
                }
                setRenamingSetup(null);
              }}
            />
          ) : (
            <span key={s.name} className="sp-saved">
              <button
                className="sp-pill is-saved"
                aria-pressed={isCustom && loadedFrom === s.name}
                title={`Your saved setup: ${s.roles.map((r) => r.role).join(', ')}. Press F2 to rename.`}
                onClick={() => {
                  setPresetId(CUSTOM_ID);
                  setCustom(s.roles);
                  setCustomName(s.name);
                  setLoadedFrom(s.name);
                  setPicks(s.models);
                  // Its saved list, or the default one; a setup saved before has none (Amendment 142).
                  setListedEdit(s.listed ? [...s.listed] : null);
                  setForgetting(null);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'F2') return;
                  e.preventDefault();
                  setForgetting(null);
                  setRenamingSetup(s.name);
                }}
              >
                {s.name}
              </button>
              {forgetting !== s.name && (
                <button
                  type="button"
                  className="sp-ghost"
                  aria-label={`Rename saved stack ${s.name}`}
                  title={`Rename ${s.name} (F2)`}
                  onClick={() => {
                    setForgetting(null);
                    setRenamingSetup(s.name);
                  }}
                >
                  ✎
                </button>
              )}
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
            orchestrable={has.helpers}
            onSave={() => {
              const name = customName.trim();
              // Your own picks only: a persona's model is the persona's, read at launch (Amendment 68).
              // With a row that orchestrates, the roles listed under it go too (Amendment 142).
              writeSetting(SETUPS_KEY, withSetup(saved, setupOf(name, custom, ownPicks, listedEdit ?? defaultListed(personas))));
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

        {missingListed.length > 0 && models.catalog && (
          <div className="sp-cf-note t-fail is-still">
            {models.catalog.host ?? 'The model API'} serves no {[...new Set(missingListed.map((r) => r.tier))].join(' or ')}{' '}
            model, which the orchestrator would start {missingListed.map((r) => r.id).join(', ')} on — pick another tier
            for {missingListed.length === 1 ? 'it' : 'each'} below.
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
              const note = rowOverrides(r, pills, mode, personas);
              return (
              <div
                className={`sp-areorder${movable ? ` sp-reorder${reorder.markOf(i)}` : ''}${r.orchestrates ? ' is-orch' : ''}`}
                key={r.role}
                {...(movable ? reorder.rowProps(i) : {})}
              >
                <div className="sp-arow">
                  {movable && reorder.handle(i, r.role)}
                  <i className="sp-dot" />
                  <span className="sp-role">{r.role}</span>
                  {/* The orchestrator of an orchestrated stack: only when it has roles to start, so two or more agents (Amendment 128). */}
                  {r.orchestrates && <OrchestratorMark />}
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
                  {has.helpers && !r.orchestrates && r.role !== listsUnder && (
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
                {/* What this row runs with that you didn't click, and why (Amendment 147). */}
                {note && <div className="sp-rownote">{note}</div>}
                {/*
                 * One agent's role and persona (Amendment 179), with the row Custom setup and a
                 * job's "+ agent" use. Its brief is the prompt, so the row has none; its model is
                 * the picker above. Kept for the project, so its next one agent starts as this.
                 */}
                {presetId === SINGLE_ID && (
                  <div className="sp-single">
                    <datalist id="sp-single-roles">
                      {KNOWN_ROLES.map((k) => (
                        <option key={k} value={k} />
                      ))}
                    </datalist>
                    <RoleRow
                      label="The agent"
                      role={singlePick.role}
                      persona={singlePick.persona}
                      shownPersona={rowPersona(asRow(singlePick), personas)}
                      brief=""
                      personas={personas}
                      rolesList="sp-single-roles"
                      waitOptions={[]}
                      waits={[]}
                      onRole={(role) => chooseSingle({ ...singlePick, role })}
                      onPersona={pickSinglePersona}
                      onToggleWait={() => undefined}
                    />
                    {singleProblems(singlePick).map((p) => (
                      <div key={p} className="sp-cf-note t-fail is-still">
                        {p}
                      </div>
                    ))}
                    <div className="sp-rownote">
                      {selected ? `Remembered for ${selected.name}: its next one agent starts as this.` : 'Pick a project to remember it there.'}
                    </div>
                  </div>
                )}
                {/*
                 * The roles an orchestrated stack's orchestrator may start (Amendment 128), under
                 * its row: editable here, sent with the launch. With none listed the row above is
                 * one plain agent, and this is where to add a role back.
                 */}
                {listsRoles && r.role === listsUnder && (
                  <Pipeline
                    listed={listed}
                    personas={personas}
                    pills={pills}
                    mode={mode}
                    tiers={tiers}
                    claude={claude}
                    model={launchOn.model}
                    onChange={setListedEdit}
                    helpers={inAll}
                    onHelpers={setPipeHelpers}
                    {...(stacked
                      ? { stacks: { n: stacks, max: stacksMax, onChange: setStacks, notes: stacksNotes(stacks, free) } }
                      : {})}
                    {...(isCustom
                      ? { alone: `No role listed, so ${r.role} launches as an ordinary agent and nothing orchestrates. Add a role to have it run a pipeline.` }
                      : {})}
                  />
                )}
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
          <span
            className="sp-pill"
            aria-pressed={budgetPerAgent !== null}
            title={`What each agent may spend per day. It warns when it has spent this much today, never stops it, and starts again at midnight. Empty for no cap.`}
          >
            ⏱ budget per agent per day $
            <input
              className="sp-input"
              style={{ width: '3.6em', marginLeft: 4, padding: '1px 5px' }}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              inputMode="decimal"
            />
          </span>
          ) : (
            /* No dollars from this engine, so its cap is tokens, input plus output (Amendment 77), per day (Amendment 129). */
            <span
              className="sp-pill"
              aria-pressed={tokenCap !== null}
              title={`What each agent may use per day, input plus output tokens. It warns at this figure, never stops it, and starts again at midnight. Empty for no cap.`}
            >
              ⏱ budget per agent per day
              <input
                className="sp-input"
                style={{ width: '4.2em', marginLeft: 4, marginRight: 4, padding: '1px 5px' }}
                value={budgetTok}
                onChange={(e) => setBudgetTok(e.target.value)}
                aria-label="Tokens per agent per day, input plus output. Empty for no cap."
              />
              tokens
            </span>
          )}
        </div>
        {tokenWhy && <div className="sp-cf-note t-fail is-still">{tokenWhy}</div>}
        {/* Each stack is a job with this budget of its own (Amendment 181). */}
        {stacksBudgetLine(stacks, jobBudget) && <div className="sp-cf-note">{stacksBudgetLine(stacks, jobBudget)}</div>}

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
                budget per agent per day <code>{autonomy.budgetUsd === null ? 'uncapped' : `$${autonomy.budgetUsd}`}</code>
              </>
            ) : (
              <>
                budget per agent per day{' '}
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
                : stacks > 1
                  ? `launch ${stacks} stacks`
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
      {launchedStacks && <LaunchedStacks result={launchedStacks} />}
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

/**
 * What a batch launch did (Amendment 181): every stack asked for, in order, the ones started
 * with the way into their job and the one git refused with its reason. A 207 is read here, so
 * a stack that failed after others started is said as that and not as "Launch failed".
 */
function LaunchedStacks({ result }: { result: CreateJobsResponse }) {
  const made = new Map(result.jobs.map((r) => [r.job.id, r]));
  const started = result.stacks.filter((s) => 'jobId' in s).length;
  return (
    <div className="sp-done">
      <div className="sp-done-title">
        {started === result.stacks.length
          ? `${started} stacks launched`
          : `${started} of ${result.stacks.length} stacks launched`}
      </div>
      {result.stacks.map((s) => {
        const r = 'jobId' in s ? made.get(s.jobId) : undefined;
        const first = r?.agents[0];
        return (
          <div className="sp-done-row" key={s.stack}>
            <i className="sp-dot" />
            <span className="sp-role">stack {s.stack}</span>
            {'error' in s ? (
              <span className="sp-does t-fail">not started: {s.error}</span>
            ) : (
              <>
                <span className="sp-model">{r?.job.branch ?? s.jobId}</span>
                {first && (
                  <button className="sp-link" onClick={() => navigate('agent', { agentId: first.id })}>
                    watch →
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function describeJob(job: Job): string {
  return `${job.worktreePath}${job.budgetUsd === null ? '' : ` · daily budget $${job.budgetUsd}`}`;
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
