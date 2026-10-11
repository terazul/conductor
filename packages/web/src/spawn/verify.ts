/**
 * Track A verification — the Spawn screen's pure logic.
 *
 * TRACK A owns this file. It does not touch W0's web verify (src/lib/verify.ts).
 *
 *   pnpm --filter @conductor/web exec tsx src/spawn/verify.ts
 *
 * No daemon, no browser, no cost: everything asserted here is a pure function that
 * turns UI state into the `AgentSpec[]` and `Autonomy` the daemon is sent.
 *
 * WHY THIS SCRIPT EXISTS. These functions decide what an agent is allowed to do to
 * your files, and every one of their mistakes is silent. A preset whose plan
 * preview reads "writes nothing" and whose autonomy permits writing looks correct
 * on screen, launches without error, and is discovered when a file changes that
 * should not have. There is no test the SDK can run for us here — the wrong value
 * is a perfectly valid one.
 *
 * So the load-bearing assertions are the negative ones: for every reading role, in
 * every preset, under the most permissive pills a user can set, the write tools are
 * denied and nothing is auto-approved.
 */

import { MODEL_NICKNAMES, pipelineHelperCap, readOnlyRefusal, showsOrchestrator, type Agent, type ModelCatalog } from '@conductor/shared';
import { addAgentProblems, addAgentSpec, addedAutonomy, budgetDefault, feedOptions, jobEngine, parseCap, rewirePreview, waitOptions, type AddDraft } from './stack.js';
import {
  DEFAULT_BUDGET_USD,
  DEFAULT_MODE,
  MODES,
  EFFORTS,
  PILLS,
  defaultPills,
  describeAutonomy,
  toAutonomy,
  type PillState,
} from './autonomy.js';
import { scopedRules, toolPolicy } from '../shell/autonomy.js';
import { BUILT_IN, LAUNCH_KEYS, launchDefaults, launchPatch } from './defaults.js';
import { BUILT_IN_PERSONAS, isEdited, newPersonaId, personaFor, personasFrom, pillsWith, resetPersona, withPersona, withoutPersona } from './personas.js';
import { FIRST_ROLE, KNOWN_ROLES, addRow, customProblems, nextRole, parseSetups, personaPicks, removeRole, renameRole, roleFromName, rowPersona, toPreset, withSetup, withoutSetup, type CustomRole } from './custom.js';
import { chain, moveRow, onDefault, recheckWaits, removeRow, rolesAbove, sameStack, toggleWait } from './order.js';
import { DEFAULT_METHOD, METHODS, branchProblem, isolationOf, launchBody, methodFrom, methodReady, presetLabel } from './launch.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ALL_ON, CLAUDE, NONE, capabilitiesOf, type Capabilities } from '../lib/providers.js';
import { DEFAULT_BUDGET_TOKENS, autonomyOn, jobBudgetUsd, modeOn, specsOn } from './engine.js';
import {
  PRESETS,
  TIER_HINTS,
  isReadOnlyRole,
  presetById,
  startsWhen,
  commonPick,
  modelFor,
  pickAll,
  pickFor,
  readsOnly,
  toAgentSpecs,
  unresolvedRoles,
  orchestratedFor,
} from './presets.js';
import {
  ORCHESTRATED_ID,
  defaultListed,
  helperCapFor,
  offeredRoles,
  orchestrates,
  sendBackWords,
  stackAgents,
  unresolvedListed,
  withRole,
  withTier,
  withoutRole,
  type ListedRole,
} from './orchestrated.js';

let failures = 0;

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Every pill on. What a user who wants no interruptions would set. */
const PERMISSIVE: PillState = {
  acceptEdits: true,
  allowBash: true,
  allowPush: true,
  network: true,
  plan: false,
};

const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

console.log('\n1 · the presets are coherent');

check('there are presets', PRESETS.length > 0, `${PRESETS.length}`);
check(
  'ids are unique',
  new Set(PRESETS.map((p) => p.id)).size === PRESETS.length,
  PRESETS.map((p) => p.id).join(','),
);
for (const preset of PRESETS) {
  const roles = preset.roles.map((r) => r.role);
  check(
    `${preset.id}: roles are unique, so dependsOnRoles resolves to one agent each`,
    new Set(roles).size === roles.length,
    roles.join(','),
  );
  check(
    `${preset.id}: every dependency is a role in the same preset`,
    preset.roles.every((r) => (r.dependsOnRoles ?? []).every((d) => roles.includes(d))),
    JSON.stringify(preset.roles.map((r) => r.dependsOnRoles ?? [])),
  );
  check(
    `${preset.id}: at least one agent can start immediately — otherwise nothing ever runs`,
    preset.roles.some((r) => (r.dependsOnRoles ?? []).length === 0),
    JSON.stringify(preset.roles.map((r) => startsWhen(r))),
  );
  check(
    `${preset.id}: every role says what it is for`,
    preset.roles.every((r) => r.does.length > 0),
  );
}

console.log('\n2 · a reading role cannot be promoted into a writer');

/*
 * The check that matters. `acceptEdits: false` alone would pass a naive reading of
 * "read-only" while still letting the agent write the moment a human approved a
 * prompt — so the assertion is about `disallowedTools`, which is the only setting
 * that survives every permission mode.
 */
for (const preset of PRESETS) {
  const specs = toAgentSpecs(preset, PERMISSIVE, 5);
  for (const spec of specs) {
    if (!isReadOnlyRole(spec.role)) continue;
    check(
      `${preset.id}/${spec.role}: write tools denied outright, not merely unapproved`,
      WRITE_TOOLS.every((t) => spec.autonomy.disallowedTools.includes(t)),
      JSON.stringify(spec.autonomy.disallowedTools),
    );
    check(
      `${preset.id}/${spec.role}: not in acceptEdits mode even though the pill is on`,
      spec.autonomy.mode !== 'acceptEdits',
      spec.autonomy.mode,
    );
    check(
      `${preset.id}/${spec.role}: shell still asks even though "ask before bash" is off`,
      !spec.autonomy.allowedTools.includes('Bash'),
      JSON.stringify(spec.autonomy.allowedTools),
    );
    check(
      `${preset.id}/${spec.role}: can still read, or it cannot do its job`,
      ['Read', 'Glob', 'Grep'].every((t) => spec.autonomy.allowedTools.includes(t)),
      JSON.stringify(spec.autonomy.allowedTools),
    );
  }
}

const analysis = presetById('analysis');
check('the analysis preset exists', analysis.id === 'analysis', analysis.id);
check(
  'it is an analyst and then a scribe — the auditor has left it (Amendment 41), the documenter too (Amendment 84)',
  analysis.roles.map((r) => r.role).join(',') === 'analyst,scribe',
  analysis.roles.map((r) => r.role).join(','),
);
const [analystRole, documenterRole] = analysis.roles;
check(
  'the analyst still writes nothing — it starts now, and its report is what the documenter reads',
  isReadOnlyRole(analystRole!.role) && (analystRole!.dependsOnRoles ?? []).length === 0,
);
check(
  'the documenter waits for the analyst, so it is handed the report rather than racing it',
  (documenterRole!.dependsOnRoles ?? []).join() === 'analyst' &&
    startsWhen(documenterRole!) === 'after analyst',
  startsWhen(documenterRole!),
);
const [analystSpec, documenterSpec] = toAgentSpecs(analysis, PERMISSIVE, 5);
check(
  'and it can write — a documenter denied Write would produce a report about docs, not docs',
  !isReadOnlyRole(documenterRole!.role) &&
    documenterSpec!.autonomy.mode === 'acceptEdits' &&
    !documenterSpec!.autonomy.disallowedTools.includes('Write'),
  JSON.stringify(documenterSpec?.autonomy),
);
check(
  'while the analyst in the same job is still denied it',
  analystSpec!.autonomy.disallowedTools.includes('Write') && analystSpec!.autonomy.mode !== 'acceptEdits',
);
check(
  'the documenter\'s brief keeps it to docs — that limit is words, so the words must be there',
  /documentation only/i.test(documenterRole!.brief) && /no source/i.test(documenterRole!.brief),
  documenterRole!.brief,
);
check(
  'an auditor launched before the change is still read-only — its role is what it was promised',
  isReadOnlyRole('auditor'),
);

const fullRoles = presetById('full').roles;
check(
  'the full pipeline runs architect, developer, validator, reviewer, scribe — in that order',
  fullRoles.map((r) => r.role).join(',') === 'architect,developer,validator,reviewer,scribe',
  fullRoles.map((r) => r.role).join(','),
);
check(
  'only the architect starts at once; the developer waits for its plan',
  fullRoles.filter((r) => (r.dependsOnRoles ?? []).length === 0).map((r) => r.role).join() === 'architect' &&
    startsWhen(fullRoles[1]!) === 'after architect',
  fullRoles.map((r) => startsWhen(r)).join(' | '),
);
const analysisOnly = presetById('analysis-only');
check(
  'Analysis Only is the analyst, then the scribe — and the analyst stays read-only',
  analysisOnly.id === 'analysis-only' &&
    analysisOnly.label === 'Analysis Only' &&
    analysisOnly.roles.map((r) => r.role).join() === 'analyst,scribe' &&
    startsWhen(analysisOnly.roles[1]!) === 'after analyst' &&
    isReadOnlyRole('analyst') &&
    !isReadOnlyRole('scribe'),
);
check(
  'developer is a built-in persona, so the full pipeline’s developer row has one',
  BUILT_IN_PERSONAS.some((p) => p.id === 'developer') && KNOWN_ROLES.includes('developer'),
);

const builder = toAgentSpecs(presetById('full'), PERMISSIVE, 5).find((s) => s.role === 'developer');
check(
  'a writing role is left alone — the override is not a blanket ban',
  builder !== undefined &&
    builder.autonomy.mode === 'acceptEdits' &&
    !builder.autonomy.disallowedTools.includes('Write'),
  JSON.stringify(builder?.autonomy),
);

console.log('\n3 · the pills compose into what the screen claims');

const defaults = toAutonomy(defaultPills(), DEFAULT_BUDGET_USD);
check('defaults auto-accept edits', defaults.mode === 'acceptEdits', defaults.mode);
check(
  'and route bash to the attention queue by ABSENCE, never by allowing it',
  !defaults.allowedTools.includes('Bash'),
  JSON.stringify(defaults.allowedTools),
);
check(
  'never-push is a rule, not a bare tool name — it must not forbid git itself',
  defaults.disallowedTools.includes('Bash(git push:*)') &&
    !defaults.disallowedTools.includes('Bash'),
  JSON.stringify(defaults.disallowedTools),
);
check(
  'planning mode overrides auto-accept',
  toAutonomy({ ...defaultPills(), plan: true }, null).mode === 'plan',
);
check(
  'granting "run shell unattended" is the only thing that allows Bash',
  toAutonomy({ ...defaultPills(), allowBash: true }, null).allowedTools.includes('Bash'),
);
check(
  'and the pills are all in the same direction — on grants, never withholds',
  toAutonomy(defaultPills(), null).allowedTools.includes('Bash') === false &&
    toAutonomy({ ...defaultPills(), allowPush: true }, null).disallowedTools.every(
      (t) => !t.includes('git push'),
    ),
  JSON.stringify(toAutonomy({ ...defaultPills(), allowPush: true }, null)),
);
check(
  'network off is a denial, not an omission — omission would let the SDK decide',
  toAutonomy(defaultPills(), null).disallowedTools.includes('WebFetch'),
);
check('the budget reaches the spec', defaults.budgetUsd === DEFAULT_BUDGET_USD, `${defaults.budgetUsd}`);
check(
  'and defaults to a lifetime $25 — $5 was a per-message figure',
  DEFAULT_BUDGET_USD === 25,
  `${DEFAULT_BUDGET_USD}`,
);
check(
  'an uncapped budget is null, not zero — zero would stop every agent instantly',
  toAutonomy(defaultPills(), null).budgetUsd === null,
);
check(
  'the summary names the mode a human would recognise',
  describeAutonomy(defaults).includes('edits files unattended'),
  describeAutonomy(defaults),
);
check(
  'every pill the UI renders is one toAutonomy actually reads',
  PILLS.every((p) => p.id in defaultPills()),
  PILLS.map((p) => p.id).join(','),
);

console.log('\n4 · effort');

check(
  'the default is the SDK default, named rather than left blank',
  toAutonomy(defaultPills(), null).effort === 'high',
  toAutonomy(defaultPills(), null).effort,
);
check(
  'a chosen level reaches the autonomy',
  toAutonomy(defaultPills(), null, 'max').effort === 'max',
);
check(
  'and every level the UI offers is one the SDK accepts',
  EFFORTS.every((e) => ['low', 'medium', 'high', 'xhigh', 'max'].includes(e.id)),
  EFFORTS.map((e) => e.id).join(','),
);
check(
  'it flows to every agent in a preset, not just the first',
  toAgentSpecs(presetById('analysis'), defaultPills(), null, 'low').every(
    (s) => s.autonomy.effort === 'low',
  ),
);
check(
  'the summary line mentions it, so the resolved panel cannot disagree with the pills',
  describeAutonomy(toAutonomy(defaultPills(), null, 'xhigh')).includes('xhigh'),
  describeAutonomy(toAutonomy(defaultPills(), null, 'xhigh')),
);

console.log('\n5 · the model: tiers resolved to exact ids (Amendment 40)');

/* What the gateway said on 29 Sep 2026: opus and sonnet served, haiku not. */
const TIERS: ModelCatalog['tiers'] = {
  opus: 'us.anthropic.claude-opus-5-5',
  sonnet: 'us.anthropic.claude-sonnet-5',
};

const perRole = toAgentSpecs(presetById('full'), defaultPills(), null, undefined, {}, TIERS);
check(
  'left alone, each role gets the exact id its tier means now — not the tier',
  perRole.find((s) => s.role === 'architect')?.model === 'us.anthropic.claude-opus-5-5' &&
    perRole.find((s) => s.role === 'developer')?.model === 'us.anthropic.claude-sonnet-5' &&
    perRole.find((s) => s.role === 'scribe')?.model === 'us.anthropic.claude-sonnet-5',
  perRole.map((s) => `${s.role}=${s.model}`).join(' '),
);
check(
  'no spec Spawn sends names a nickname when every tier resolves',
  PRESETS.every((p) =>
    toAgentSpecs(p, defaultPills(), null, undefined, {}, TIERS).every(
      (s) => !(MODEL_NICKNAMES as readonly string[]).includes(s.model),
    ),
  ),
);

/*
 * Per-role picks (Amendment 41). The question that asked for them: "how do I assign
 * different models to different roles" — one override for every role could not.
 */
const full = presetById('full');
const reviewerRole = full.roles.find((r) => r.role === 'reviewer')!;
const builderRole = full.roles.find((r) => r.role === 'developer')!;
const scribeRole = full.roles.find((r) => r.role === 'scribe')!;
const GPT = 'openai.gpt-5.5';

const onePick = pickFor({}, reviewerRole, GPT, TIERS);
const picked = toAgentSpecs(full, defaultPills(), null, undefined, onePick, TIERS);
check(
  'a pick on one row changes that role and no other',
  picked.every((s, i) => s.model === (s.role === 'reviewer' ? GPT : perRole[i]!.model)),
  picked.map((s) => `${s.role}=${s.model}`).join(' '),
);
check(
  'two rows can be given two different models — the point of it',
  (() => {
    const two = pickFor(onePick, builderRole, TIERS.sonnet!, TIERS);
    const specs = toAgentSpecs(full, defaultPills(), null, undefined, two, TIERS);
    return (
      specs.find((s) => s.role === 'reviewer')?.model === GPT &&
      specs.find((s) => s.role === 'developer')?.model === TIERS.sonnet
    );
  })(),
);
check(
  'and a pick does not disturb anything else — roles, deps and autonomy survive',
  picked.length === perRole.length &&
    picked.every((s, i) => s.role === perRole[i]!.role && (s.dependsOnRoles ?? []).join() === (perRole[i]!.dependsOnRoles ?? []).join()) &&
    picked.find((s) => s.role === 'reviewer')?.autonomy.disallowedTools.includes('Write') === true,
);
check(
  'picking what a row\'s tier already means puts it back on its tier rather than storing a pick',
  pickFor(onePick, reviewerRole, TIERS.opus!, TIERS).reviewer === undefined &&
    pickFor({}, scribeRole, TIERS.sonnet!, TIERS).scribe === undefined,
);
check(
  'an empty choice on a row also puts it back on its tier',
  pickFor(onePick, reviewerRole, '', TIERS).reviewer === undefined,
);

const everyGpt = pickAll(full, GPT);
check(
  '"every role" sets every row, not just the first',
  toAgentSpecs(full, defaultPills(), null, undefined, everyGpt, TIERS).every((s) => s.model === GPT),
);
check(
  'and the top picker then says so',
  commonPick(full, everyGpt, TIERS) === GPT,
  String(commonPick(full, everyGpt, TIERS)),
);
check(
  'once one row differs, it says "per role" instead of claiming a model some rows are not on',
  commonPick(full, pickFor(everyGpt, scribeRole, TIERS.sonnet!, TIERS), TIERS) === null,
);
check(
  'with no picks it says "per role", even where every tier happens to mean the same id',
  commonPick(presetById('single'), {}, TIERS) === null &&
    commonPick(full, {}, { opus: GPT, sonnet: GPT }) === null,
);
check(
  '"per role" on the top picker clears every row',
  Object.keys(pickAll(full, '')).length === 0,
);
check(
  'every tier a preset names has a hint for the plan preview',
  PRESETS.every((p) => p.roles.every((r) => typeof TIER_HINTS[r.model] === 'string')),
  PRESETS.flatMap((p) => p.roles.map((r) => r.model)).join(','),
);

const roles = (xs: { role: string }[]): string => xs.map((r) => r.role).join(',');
check(
  'a preset whose tiers are all served has no row without a model',
  unresolvedRoles(full, TIERS, {}).length === 0,
  roles(unresolvedRoles(full, TIERS, {})),
);
check(
  'a tier the model API does not serve names the rows that need a pick — so Spawn can say which',
  roles(unresolvedRoles(full, { opus: TIERS.opus }, {})) === 'developer,validator,scribe',
  roles(unresolvedRoles(full, { opus: TIERS.opus }, {})),
);
check(
  'picking a model on one of those rows resolves that row only',
  roles(unresolvedRoles(full, { opus: TIERS.opus }, { validator: GPT })) === 'developer,scribe',
);
check(
  'with no catalog yet, every row is unresolved — launching then would send nicknames',
  unresolvedRoles(full, {}, {}).length === full.roles.length,
);
check(
  '"every role" resolves every row, whatever the catalog lacks',
  unresolvedRoles(full, {}, pickAll(full, GPT)).length === 0,
);
check(
  'modelFor is what the row shows and what is sent — the same answer',
  full.roles.every(
    (r, i) => modelFor(r, onePick, TIERS) === picked[i]!.model,
  ),
);

console.log('\n6 · reading a policy back — what the inspector shows');

/*
 * The bug this section exists for: `toolPolicy` matched `disallowedTools` with a prefix
 * test, so `Bash(git push:*)` — which the "never push" default always adds — made the
 * inspector report **bash: denied** for an agent that could run bash all day. A confident
 * one-word answer that was wrong, on the panel whose whole job is telling you what an
 * agent may do.
 *
 * `absent from allowedTools` means ASKS. Only a rule naming the tool itself means denied.
 */
const withDefaults = toAutonomy(defaultPills(), null);
check(
  'bash ASKS under the defaults — a scoped git-push deny is not a bash deny',
  toolPolicy(withDefaults, 'Bash') === 'asks',
  `${toolPolicy(withDefaults, 'Bash')} · ${JSON.stringify(withDefaults.disallowedTools)}`,
);
check(
  'and the git-push rule is still reported, as the exception it is',
  scopedRules(withDefaults.disallowedTools, 'Bash').length === 1,
  JSON.stringify(scopedRules(withDefaults.disallowedTools, 'Bash')),
);
check(
  'granting shell makes it allowed',
  toolPolicy(toAutonomy({ ...defaultPills(), allowBash: true }, null), 'Bash') === 'allowed',
);
check(
  'a rule naming the whole tool IS denied',
  toolPolicy({ ...withDefaults, disallowedTools: ['Bash'] }, 'Bash') === 'denied',
);
check(
  'webfetch is denied outright when network is off — that one is a bare rule',
  toolPolicy(withDefaults, 'WebFetch') === 'denied',
  JSON.stringify(withDefaults.disallowedTools),
);
check(
  'write asks by default rather than reading as denied',
  toolPolicy(withDefaults, 'Write') === 'asks',
  toolPolicy(withDefaults, 'Write'),
);
check(
  'a read-only role reports write as denied, because that is a bare rule',
  toolPolicy(
    toAgentSpecs(presetById('analysis'), defaultPills(), null)[0]!.autonomy,
    'Write',
  ) === 'denied',
);
check(
  'and bypass does not override a bare deny — disallowedTools survives every mode',
  toolPolicy({ ...withDefaults, mode: 'bypassPermissions' }, 'WebFetch') === 'denied',
);

console.log("\n7 · Spawn starts from the Settings tab's launch defaults (Amendment 47)");
{
  const none = launchDefaults(() => null);
  check('with nothing set, the built-in defaults', JSON.stringify(none) === JSON.stringify(BUILT_IN), JSON.stringify(none));
  const kept: Record<string, string> = {
    [LAUNCH_KEYS.preset]: 'analysis',
    [LAUNCH_KEYS.isolation]: 'named',
    [LAUNCH_KEYS.pills]: JSON.stringify({ allowBash: true, nonsense: true, network: 'yes' }),
    [LAUNCH_KEYS.budget]: '',
    [LAUNCH_KEYS.effort]: 'low',
    [LAUNCH_KEYS.model]: ' us.anthropic.claude-sonnet-5 ',
  };
  const d = launchDefaults((k) => kept[k] ?? null);
  check('each one set is read', d.preset === 'analysis' && d.method === 'named' && d.effort === 'low' && d.budget === '' && d.model === 'us.anthropic.claude-sonnet-5', JSON.stringify(d));
  check('only real pills, only as booleans; the rest keep their default', d.pills['allowBash'] === true && !('nonsense' in d.pills) && d.pills['network'] === false && d.pills['acceptEdits'] === true, JSON.stringify(d.pills));
  const bad = launchDefaults((k) => ({ [LAUNCH_KEYS.preset]: 'gone', [LAUNCH_KEYS.isolation]: 'moon', [LAUNCH_KEYS.effort]: 'huge', [LAUNCH_KEYS.budget]: '-3', [LAUNCH_KEYS.pills]: '{nope' } as Record<string, string>)[k] ?? null);
  check('a value that is not one reads as the default, so Spawn always opens', JSON.stringify(bad) === JSON.stringify(BUILT_IN), JSON.stringify(bad));
  const patch = launchPatch({ ...BUILT_IN, effort: 'low' });
  check('saving writes only what differs, and clears the rest', patch[LAUNCH_KEYS.effort] === 'low' && patch[LAUNCH_KEYS.preset] === null && patch[LAUNCH_KEYS.pills] === null && patch[LAUNCH_KEYS.model] === null, JSON.stringify(patch));
  check('the built-in defaults write nothing at all', Object.values(launchPatch(BUILT_IN)).every((v) => v === null), JSON.stringify(launchPatch(BUILT_IN)));
  const round = launchDefaults((k) => launchPatch(d)[k] ?? null);
  check('and what it writes reads back the same', JSON.stringify(round) === JSON.stringify(d), JSON.stringify(round));
  const src = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  check('Spawn reads them when it opens', /useState\(\(\) => launchDefaults\(readSetting\)\)/.test(src) && /useState<Method>\(start\.method\)/.test(src));
}

console.log('\n8 · custom setups, built by hand and saved by name (Amendment 50)');
{
  const roles: CustomRole[] = [
    { role: 'builder-api', brief: 'Build the API.', dependsOnRoles: [] },
    { role: 'builder-ui', brief: 'Build the UI.\nMatch the mockup.', dependsOnRoles: [] },
    { role: 'reviewer', brief: '', dependsOnRoles: ['builder-api', 'builder-ui'] },
  ];
  check('a good setup has no problems', customProblems(roles).length === 0, customProblems(roles).join(' | '));
  check('an empty one needs an agent', customProblems([]).length === 1);
  check('a role twice is refused — the daemon resolves waits by role', customProblems([roles[0]!, roles[0]!]).some((p) => /twice/.test(p)));
  check('so is a role that is not a name', customProblems([{ ...FIRST_ROLE, role: 'Build It' }]).some((p) => /lowercase/.test(p)));
  check('and waiting for one that is not above it', customProblems([{ ...roles[2]! }, roles[0]!, roles[1]!]).some((p) => /isn't above it/.test(p)));
  check('a new row takes the first free known role', nextRole([FIRST_ROLE]) === 'validator');
  const renamed = renameRole(roles, 0, 'api');
  check('renaming a row renames what waits on it', renamed[0]?.role === 'api' && JSON.stringify(renamed[2]?.dependsOnRoles) === JSON.stringify(['api', 'builder-ui']));
  const removed = removeRole(roles, 1);
  check('removing a row removes the waits on it', removed.length === 2 && JSON.stringify(removed[1]?.dependsOnRoles) === JSON.stringify(['builder-api']));
  const p = toPreset('custom', 'mine', roles);
  check('as a preset: same roles, briefs and waits', p.roles.map((r) => r.role).join() === 'builder-api,builder-ui,reviewer' && p.roles[2]?.dependsOnRoles?.length === 2 && p.roles[0]?.brief === 'Build the API.');
  check("the plan preview's line is the brief's first line", p.roles[1]?.does === 'Build the UI.' && p.roles[2]?.does === 'does what the prompt says');
  const specs = toAgentSpecs(p, defaultPills(), 5, undefined, { reviewer: 'openai.gpt-5.5' }, { sonnet: 'us.anthropic.claude-sonnet-5' });
  check('each row gets its own model, the rest the default tier', specs.find((x) => x.role === 'reviewer')?.model === 'openai.gpt-5.5' && specs.find((x) => x.role === 'builder-ui')?.model === 'us.anthropic.claude-sonnet-5');
  check('a custom reviewer is still read-only — the promise is the role, not the preset', specs.find((x) => x.role === 'reviewer')?.autonomy.disallowedTools.includes('Write') === true);
  check('and waits for what it said', specs.find((x) => x.role === 'reviewer')?.dependsOnRoles?.join() === 'builder-api,builder-ui');

  const one = withSetup([], { name: 'api+ui', roles, models: { reviewer: 'openai.gpt-5.5' } });
  const back = parseSetups(one);
  check('a saved setup reads back whole, models and all', back.length === 1 && back[0]?.name === 'api+ui' && back[0]?.roles.length === 3 && back[0]?.models['reviewer'] === 'openai.gpt-5.5', one);
  const two = parseSetups(withSetup(back, { name: 'api+ui', roles: [FIRST_ROLE], models: {} }));
  check('saving the same name replaces it', two.length === 1 && two[0]?.roles.length === 1);
  check('forgetting the last one clears the setting', withoutSetup(two, 'api+ui') === null);
  check('anything malformed is left out, not fatal', parseSetups('{nope').length === 0 && parseSetups(JSON.stringify([{ name: 'bad', roles: [{ role: 'A B' }] }, { roles: [] }, { name: 'ok', roles: [{ role: 'builder' }] }])).map((x) => x.name).join() === 'ok');
  const src = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  check('Spawn launches it, and waits while it has a problem', /toPreset\(CUSTOM_ID/.test(src) && /!customBad/.test(src));
}

console.log('\n9 · several agents on one role (Amendment 51)');
{
  const specs = toAgentSpecs(presetById('full'), defaultPills(), 5, undefined, {}, {}, { developer: 3, validator: 0 });
  check('a role given helpers sends how many it may start', specs.find((x) => x.role === 'developer')?.helpers === 3);
  check('the rest send none, so an ordinary job is what it always was', specs.filter((x) => x.role !== 'developer').every((x) => !('helpers' in x)));
  const src = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  check('each plan row can put helpers on its role, and a preset change clears them', /setHelpers\(\(h\) => \(\{ \.\.\.h, \[r\.role\]/.test(src) && /setHelpers\(\{\}\)/.test(src));
}

console.log('\n10 · how the agents interact with you, chosen at launch (Amendment 65)');
{
  check('five modes, each a mode the SDK takes', MODES.map((m) => m.id).join() === 'default,acceptEdits,plan,auto,bypassPermissions');
  check('only bypass carries a warning, and it says nothing will ask you', MODES.filter((m) => m.warn).map((m) => m.id).join() === 'bypassPermissions' && /Nothing will ask you/.test(MODES.find((m) => m.warn)!.warn!));
  for (const m of MODES) {
    const specs = toAgentSpecs(presetById('full'), defaultPills(), 5, undefined, {}, {}, {}, m.id);
    const builder = specs.find((x) => x.role === 'developer')!;
    const reviewer = specs.find((x) => x.role === 'reviewer')!;
    check(`${m.label}: a writing role gets it`, builder.autonomy.mode === m.id, builder.autonomy.mode);
    check(`${m.label}: a reading role stays read-only — ${m.id === 'plan' ? 'it plans' : 'it asks'}`, reviewer.autonomy.mode === (m.id === 'plan' ? 'plan' : 'default') && reviewer.autonomy.disallowedTools.includes('Write'), reviewer.autonomy.mode);
  }
  const bypass = toAutonomy({ ...defaultPills(), allowPush: false, network: false }, null, undefined, 'bypassPermissions');
  check('the mode leaves the tool rules to the pills: no push, no network still denied under bypass', bypass.disallowedTools.includes('Bash(git push:*)') && bypass.disallowedTools.includes('WebFetch'));
  check('no mode given: worked out from the pills, as before', toAutonomy(defaultPills(), null).mode === 'acceptEdits' && toAutonomy({ ...defaultPills(), plan: true }, null).mode === 'plan');
  check('the default is what Spawn did before: edits accepted', BUILT_IN.mode === 'acceptEdits' && DEFAULT_MODE === 'acceptEdits');
  check('a saved default is read, and a bad one is the default', launchDefaults((k) => (k === LAUNCH_KEYS.mode ? 'auto' : null)).mode === 'auto' && launchDefaults((k) => (k === LAUNCH_KEYS.mode ? 'yolo' : null)).mode === 'acceptEdits');
  check('the summary says when nothing will ask, shell included', describeAutonomy(bypass).startsWith('⚠ asks you nothing · runs shell unattended'), describeAutonomy(bypass));
  const src = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  check('Spawn sends the mode, and the plan button and edits pill are gone', /toAgentSpecs\(preset, pills, budgetPerAgent, effort, picks, tiers, helpers, mode(, personas(, listed)?)?\)/.test(src) && !/plan first, don't write code/.test(src) && !PILLS.some((p) => p.id === 'acceptEdits'));
}

console.log('\n11 · MCP tools, and what a reading role never gets (Amendment 67)');
{
  check('allow MCP tools puts every MCP tool in allowedTools', toAutonomy({ ...defaultPills(), mcp: true }, null).allowedTools.includes('mcp__*'));
  check('and off, none', !toAutonomy(defaultPills(), null).allowedTools.includes('mcp__*'));
  const specs = toAgentSpecs(presetById('full'), { ...defaultPills(), mcp: true, allowBash: true }, null);
  check('a writing role gets them', specs.find((x) => x.role === 'developer')!.autonomy.allowedTools.includes('mcp__*'));
  check('a reading role never does — MCP tools can change things — nor unattended shell', ['mcp__*', 'Bash'].every((t) => !specs.find((x) => x.role === 'reviewer')!.autonomy.allowedTools.includes(t)));
  check('it is a pill, off by default', PILLS.some((p) => p.id === 'mcp') && defaultPills()['mcp'] === false);
}

console.log('\n12 · personas: what a role is, editable (Amendment 68, the shared contract)');
{
  const none = personasFrom(null);
  check('with nothing saved, the built-ins, in order', none.map((p) => p.id).join() === BUILT_IN_PERSONAS.map((p) => p.id).join() && none.every((p) => p.builtIn));
  check('the reading roles are reading personas', ['reviewer', 'debugger', 'analyst'].every((id) => personaFor(none, id)?.tools.write === false));
  const edited = { ...personaFor(none, 'developer')!, systemPrompt: 'Prefer pure functions.', skills: ['tdd'] };
  let raw = withPersona(null, edited);
  check('saving a built-in keeps only what changed', JSON.stringify(JSON.parse(raw).edits.developer) === JSON.stringify({ systemPrompt: 'Prefer pure functions.', skills: ['tdd'] }), raw);
  const after = personasFrom(raw);
  check('and reads back changed, still built-in', personaFor(after, 'developer')?.systemPrompt === 'Prefer pure functions.' && personaFor(after, 'developer')?.builtIn === true && isEdited(personaFor(after, 'developer')!));
  raw = resetPersona(raw, 'developer');
  check('reset puts it back as it shipped', !isEdited(personaFor(personasFrom(raw), 'developer')!));
  const mine = { ...personaFor(none, 'developer')!, id: newPersonaId(none), name: 'migrator', builtIn: false };
  raw = withPersona(raw, mine);
  check('your own is kept whole, after the built-ins', personasFrom(raw).at(-1)?.name === 'migrator' && personasFrom(raw).at(-1)?.builtIn === false && mine.id === 'persona-1');
  check('yours can be deleted; a built-in cannot', !personasFrom(withoutPersona(raw, 'persona-1')).some((p) => p.id === 'persona-1') && personasFrom(withoutPersona(raw, 'developer')).some((p) => p.id === 'developer'));
  check('a broken setting is the built-ins', personasFrom('{nope').length === BUILT_IN_PERSONAS.length);
  check('a stored field of the wrong type is dropped', personaFor(personasFrom(JSON.stringify({ edits: { developer: { brief: 3, skills: ['a', 4] } } })), 'developer')?.skills.join() === 'a');
  check('one of yours cannot take a built-in id', personasFrom(JSON.stringify({ own: [{ id: 'developer', name: 'x' }] })).filter((p) => p.id === 'developer').length === 1);
  const pills = { acceptEdits: true, allowBash: false, allowPush: false, network: false, mcp: false };
  check('tool rules: what the persona says wins, the rest stay the launch\'s', JSON.stringify(pillsWith(pills, { bash: true, mcp: true })) === JSON.stringify({ ...pills, allowBash: true, mcp: true }));
}

console.log('\n13 · presets and Custom rows take their personas (Amendment 68)');
{
  const tiersNow = { opus: 'us.anthropic.claude-opus-5', sonnet: 'us.anthropic.claude-sonnet-5' };
  for (const p of PRESETS) {
    const plain = toAgentSpecs(p, PERMISSIVE, 5, 'high', {}, tiersNow, {}, 'auto');
    const undef = toAgentSpecs(p, PERMISSIVE, 5, 'high', {}, tiersNow, {}, 'auto', undefined);
    check(`${p.id}: without personas, the specs are what they were`, JSON.stringify(plain) === JSON.stringify(undef) && plain.every((x) => !('persona' in x) && !('systemPrompt' in x) && !('skills' in x)));
  }

  const raw = withPersona(null, { ...personaFor(BUILT_IN_PERSONAS, 'developer')!, ...{ systemPrompt: 'Prefer pure functions.', skills: ['tdd'], tools: { mcp: true }, model: 'haiku', brief: 'A persona brief.' } });
  const personas = personasFrom(raw);
  const full = presetById('full');
  const specs = toAgentSpecs(full, defaultPills(), 5, undefined, {}, tiersNow, {}, undefined, personas);
  const developer = specs.find((x) => x.role === 'developer')!;
  check('a preset role carries its persona: id, system prompt, skills', developer.persona === 'developer' && developer.systemPrompt === 'Prefer pure functions.' && developer.skills?.join() === 'tdd', JSON.stringify(developer));
  check("the persona's tool rules go over the pills: MCP on", developer.autonomy.allowedTools.includes('mcp__*') && !defaultPills()['mcp']);
  check("and the preset keeps its own brief and tier, not the persona's", developer.brief === full.roles.find((r) => r.role === 'developer')!.brief && developer.model === tiersNow.sonnet);
  // Every built-in has a system prompt since Amendment 126, so "nothing to append" is a validator edited down to none.
  const quietSpecs = toAgentSpecs(full, defaultPills(), 5, undefined, {}, tiersNow, {}, undefined, personasFrom(withPersona(raw, { ...personaFor(personas, 'validator')!, systemPrompt: '' })));
  check('a persona with nothing to append sends no system prompt or skills', quietSpecs.find((x) => x.role === 'validator')?.persona === 'validator' && !('systemPrompt' in quietSpecs.find((x) => x.role === 'validator')!) && !('skills' in quietSpecs.find((x) => x.role === 'validator')!));
  const reviewer = specs.find((x) => x.role === 'reviewer')!;
  check("a reading role's persona can't give it MCP or shell", !reviewer.autonomy.allowedTools.includes('mcp__*') && !reviewer.autonomy.allowedTools.includes('Bash') && reviewer.autonomy.disallowedTools.includes('Write'));
  const writer = personasFrom(withPersona(null, { ...personaFor(BUILT_IN_PERSONAS, 'reviewer')!, tools: { write: true, bash: true } }));
  check('nor make a reading role write', toAgentSpecs(presetById('review'), PERMISSIVE, 5, undefined, {}, {}, {}, undefined, writer)[0]!.autonomy.disallowedTools.includes('Write'));

  const reading = personasFrom(withPersona(raw, { ...personaFor(personas, 'scribe')!, tools: { write: false } }));
  const ro = toAgentSpecs(full, PERMISSIVE, 5, undefined, {}, tiersNow, {}, 'acceptEdits', reading).find((x) => x.role === 'scribe')!;
  check('a persona with write off makes its role read-only: write tools denied', WRITE_TOOLS.every((t) => ro.autonomy.disallowedTools.includes(t)), JSON.stringify(ro.autonomy));
  check('nothing auto-accepted, no unattended shell, no MCP', ro.autonomy.mode !== 'acceptEdits' && !ro.autonomy.allowedTools.includes('Bash') && !ro.autonomy.allowedTools.includes('mcp__*'), JSON.stringify(ro.autonomy));
  check('and the plan preview says read-only', readsOnly(full.roles.find((r) => r.role === 'scribe')!, reading) && !readsOnly(full.roles.find((r) => r.role === 'scribe')!, personas));

  const exact = personasFrom(withPersona(raw, { ...personaFor(personas, 'validator')!, model: 'openai.gpt-5.5' }));
  const rows: CustomRole[] = [
    { role: 'developer-api', brief: '', dependsOnRoles: [], persona: 'developer' },
    { role: 'developer-ui', brief: 'Only the UI.', dependsOnRoles: [], persona: 'developer' },
    { role: 'checker', brief: '', dependsOnRoles: ['developer-api'], persona: 'validator' },
    { role: 'plain', brief: '', dependsOnRoles: [] },
  ];
  const cp = toPreset('custom', 'custom', rows, exact);
  check("a Custom row with a persona takes its brief when its own is empty", cp.roles[0]!.brief === 'A persona brief.');
  check('and its own when typed', cp.roles[1]!.brief === 'Only the UI.');
  check('toPreset carries the persona', cp.roles[0]!.persona === 'developer' && cp.roles[2]!.persona === 'validator' && cp.roles[3]!.persona === '');
  check("a persona's tier is the row's tier; no persona, or an exact id, is sonnet", cp.roles[0]!.model === 'haiku' && cp.roles[2]!.model === 'sonnet' && cp.roles[3]!.model === 'sonnet');
  check('personaPicks gives the exact ids only', JSON.stringify(personaPicks(rows, exact)) === JSON.stringify({ checker: 'openai.gpt-5.5' }));
  const cs = toAgentSpecs(cp, defaultPills(), 5, undefined, { ...personaPicks(rows, exact), 'developer-ui': 'x.model' }, tiersNow, {}, undefined, exact);
  check("two rows share a persona; each sends it, and the row's own pick wins", cs[0]!.persona === 'developer' && cs[1]!.persona === 'developer' && cs[1]!.model === 'x.model' && cs[2]!.model === 'openai.gpt-5.5' && cs[0]!.systemPrompt === 'Prefer pure functions.');
  check('without the persona, toPreset is what it was', JSON.stringify(toPreset('custom', 'c', rows.map(({ persona: _p, ...r }) => r))) === JSON.stringify(toPreset('custom', 'c', rows.map(({ persona: _p, ...r }) => r), exact)));
  check('a deleted persona is no persona', toPreset('custom', 'c', [{ role: 'x', brief: '', dependsOnRoles: [], persona: 'persona-9' }], exact).roles[0]!.brief === '' && toAgentSpecs(toPreset('custom', 'c', [{ role: 'x', brief: '', dependsOnRoles: [], persona: 'persona-9' }], exact), defaultPills(), 5, undefined, {}, {}, {}, undefined, exact)[0]!.persona === undefined);

  const back = parseSetups(withSetup([], { name: 'pair', roles: rows, models: {} }));
  check('a saved setup keeps each persona by id', back[0]?.roles.map((r) => r.persona ?? '-').join() === 'developer,developer,validator,-', JSON.stringify(back));
  check('a persona name becomes a role name', roleFromName('Migrator Pro') === 'migrator-pro' && roleFromName('developer') === 'developer' && /^[a-z]/.test(roleFromName('2 fast')));
  const src = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  check('Spawn reads the personas setting and hands it on', /personasFrom\(personasRaw\)/.test(src) && /useSetting\(PERSONAS_KEY\)/.test(src) && /mode, personas(, listed)?\)/.test(src) && /personas=\{personas\}/.test(src) && /personaPicks\(custom, personas\)/.test(src));
}

{
  // A row named like a persona runs as it, says so, and "no persona" really is none.
  const ps = personasFrom(withPersona(null, { ...personaFor(personasFrom(null), 'developer')!, systemPrompt: 'Prefer pure functions.' }));
  const plain = { role: 'developer', brief: '', dependsOnRoles: [] };
  check('a row called developer, nothing picked, runs as developer — and the picker says so', rowPersona(plain, ps)?.id === 'developer');
  const preset = toPreset('custom', 'x', [plain, { ...plain, role: 'developer-2', persona: '' }], ps);
  check('its spec carries what the picker shows', toAgentSpecs(preset, defaultPills(), null, undefined, {}, {}, {}, undefined, ps)[0]?.systemPrompt === 'Prefer pure functions.');
  const none = toPreset('custom', 'x', [{ ...plain, persona: '' }], ps);
  check('"no persona" on a row called developer is none: no system prompt, and the picker shows none', toAgentSpecs(none, defaultPills(), null, undefined, {}, {}, {}, undefined, ps)[0]?.systemPrompt === undefined && rowPersona({ ...plain, persona: '' }, ps) === undefined);
  check('and a saved setup keeps that choice', parseSetups(withSetup([], { name: 's', roles: [{ ...plain, persona: '' }], models: {} }))[0]?.roles[0]?.persona === '');
}

console.log('\n14 · an architect among the built-ins (Amendment 70)');
{
  const arch = personaFor(personasFrom(null), 'architect');
  check('there is a built-in architect, first in the list', arch?.builtIn === true && personasFrom(null)[0]?.id === 'architect');
  check('on the strongest model, with a system prompt and a plan-shaped brief', arch?.model === 'opus' && /software architect/.test(arch.systemPrompt) && /ADR in docs\/adr\//.test(arch.brief) && /Change no source code/.test(arch.brief));
  check('it may read, run shell and write its ADR, and never pushes', JSON.stringify(arch?.tools) === JSON.stringify({ bash: true, write: true, network: true, push: false }));
  const specs = toAgentSpecs(toPreset('custom', 'x', [{ role: 'architect', brief: '', dependsOnRoles: [] }, { role: 'developer', brief: '', dependsOnRoles: ['architect'] }], personasFrom(null)), defaultPills(), 5, undefined, {}, {}, {}, undefined, personasFrom(null));
  const a = specs[0]!;
  check('a Custom architect row launches with its system prompt and its tool rules', a.persona === 'architect' && /software architect/.test(a.systemPrompt ?? '') && a.autonomy.allowedTools.includes('Bash') && a.autonomy.disallowedTools.includes('Bash(git push:*)') && !a.autonomy.disallowedTools.includes('WebFetch'), JSON.stringify(a.autonomy));
  check('and is offered as a role, after the ones new rows have always taken', KNOWN_ROLES.includes('architect') && nextRole([FIRST_ROLE]) === 'validator');
}

console.log('\n15 · an engine other than Claude (Amendment 80)');
{
  const tiersNow = { opus: 'us.anthropic.claude-opus-5', sonnet: 'us.anthropic.claude-sonnet-5', haiku: 'us.anthropic.claude-haiku-5' };
  const preset = presetById('full');
  const base = toAgentSpecs(preset, PERMISSIVE, 25, 'high', {}, tiersNow, { developer: 2 }, 'plan');
  const before = JSON.stringify(base);

  // What Copilot and OpenRouter can do, as the daemon will say (findings, Amendment 75).
  const copilotCaps: Capabilities = { defer: false, resume: true, costUsd: false, effort: true, planMode: false, helperTools: true };
  const claude = specsOn(base, { provider: CLAUDE, caps: ALL_ON, model: 'ignored', budgetTokens: 123 });
  check('a Claude launch is the very same specs: no provider, its own models, its dollars', claude === base && JSON.stringify(claude) === before && !before.includes('"provider"') && !before.includes('budgetTokens'));
  check("and the job's dollar cap is what it always was", jobBudgetUsd(25, 3, ALL_ON) === 75 && jobBudgetUsd(null, 3, ALL_ON) === null);
  const a = toAutonomy(PERMISSIVE, 25, 'high', 'plan');
  check('a Claude autonomy is handed back as it is', autonomyOn(a, { provider: CLAUDE, caps: ALL_ON, model: '', budgetTokens: 5 }) === a);

  const or = specsOn(base, { provider: 'openrouter', caps: copilotCaps, model: 'anthropic/claude-sonnet-4.5', budgetTokens: 500_000 });
  check('another engine: every spec names it, and runs on the one id picked', or.every((x) => x.provider === 'openrouter' && x.model === 'anthropic/claude-sonnet-4.5'), JSON.stringify(or.map((x) => [x.provider, x.model])));
  check('no dollars there: budgetUsd null and the cap in tokens', or.every((x) => x.autonomy.budgetUsd === null && x.autonomy.budgetTokens === 500_000), JSON.stringify(or.map((x) => x.autonomy)));
  check("and no dollar cap on the job, which the daemon would refuse", jobBudgetUsd(25, 3, copilotCaps) === null);
  check('plan mode, which it lacks, is sent as "ask me"', or.every((x) => x.autonomy.mode === 'default') && modeOn('plan', copilotCaps) === 'default' && modeOn('acceptEdits', copilotCaps) === 'acceptEdits' && modeOn('plan', ALL_ON) === 'plan');
  check('effort and helpers, which it has, are kept', or.every((x) => x.autonomy.effort === 'high') && or.find((x) => x.role === 'developer')?.helpers === 2);
  check('the tool rules are untouched — the deny list still holds there', or.every((x, i) => JSON.stringify(x.autonomy.disallowedTools) === JSON.stringify(base[i]!.autonomy.disallowedTools) && JSON.stringify(x.autonomy.allowedTools) === JSON.stringify(base[i]!.autonomy.allowedTools)));
  check('and the Claude specs it came from are unchanged', JSON.stringify(base) === before);

  const bare = specsOn(base, { provider: 'copilot', caps: NONE, model: 'gpt-5', budgetTokens: null });
  check('an engine that can do nothing: no effort, no helpers, no cap at all when none is typed', bare.every((x) => !('effort' in x.autonomy) && !('helpers' in x) && !('budgetTokens' in x.autonomy) && x.autonomy.budgetUsd === null), JSON.stringify(bare[0]));
  check('an engine the daemon hasn\'t described is trusted with nothing; Claude with everything', capabilitiesOf('copilot', null) === NONE && capabilitiesOf('copilot', []) === NONE && capabilitiesOf(CLAUDE, null) === ALL_ON && capabilitiesOf('copilot', [{ id: 'copilot', unavailable: null, capabilities: copilotCaps }]) === copilotCaps);
  check('the default token cap is a cap, and says so', DEFAULT_BUDGET_TOKENS > 0 && describeAutonomy(or[0]!.autonomy).includes('stops at 500k tokens') && !describeAutonomy(base[0]!.autonomy).includes('tokens'));

  const src = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  check('Spawn sends the specs through specsOn, and the job cap through jobBudgetUsd', /specsOn\(toAgentSpecs\(preset, pills, budgetPerAgent, effort, picks, tiers, helpers, mode, personas(, listed)?\), launchOn\)/.test(src) && /budgetUsd: jobBudgetUsd\(budgetPerAgent, specs\.length, caps\)/.test(src));
  check('the engine defaults to Claude, and one that can\'t launch is off with its reason shown', /useState\(CLAUDE\)/.test(src) && /disabled=\{id !== CLAUDE && why !== null\}/.test(src) && /\{providerLabel\(p\.id\)\}: \{p\.unavailable\}/.test(src));
  check("the model picker follows the engine: Claude's catalog, else the engine's list or any id", /\{claude \? \(\s*<div className="sp-efforts">\s*<span className="ui-lab">model<\/span>\s*<ModelSelect/.test(src) && /useProviderModels\(claude \? null : provider\)/.test(src) && /list="sp-engine-models"/.test(src) && /theirs\.list\?\.note/.test(src));
  check('the budget field is dollars or tokens, by costUsd', /has\.budget === 'usd' \? \(\s*<span className="sp-pill" aria-pressed=\{budgetPerAgent !== null\}>\s*⏱ budget per agent \$/.test(src) && /value=\{budgetTok\}/.test(src));
  check('effort, helpers and plan mode show only where the engine has them', /\{has\.effort && \(\s*<div className="sp-efforts">\s*<span className="ui-lab">effort/.test(src) && /\{has\.helpers && (!r\.orchestrates && !listsRoles && )?\(\s*<select/.test(src) && /MODES\.filter\(\(m\) => offersMode\(m\.id, caps\)\)/.test(src));
}

console.log('\n16 · fewer built-in personas, and the full pipeline reads the plan (Amendment 84)');
{
  const full = presetById('full');
  const row = (role: string) => full.roles.find((r) => r.role === role)!;
  check('the full pipeline: architect, developer, validator, reviewer, scribe', full.roles.map((r) => r.role).join() === 'architect,developer,validator,reviewer,scribe');
  check('its developer runs on sonnet, the architect and reviewer on opus', row('developer').model === 'sonnet' && row('architect').model === 'opus' && row('reviewer').model === 'opus');
  check('the validator tests what was built, against the plan', row('validator').does === 'tests what was built' && /architect's plan/.test(row('validator').brief) && /what the developer built/.test(row('validator').brief) && (row('validator').dependsOnRoles ?? []).join() === 'developer');
  check("the reviewer waits for the architect too, and reviews against its plan", (row('reviewer').dependsOnRoles ?? []).join() === 'architect,developer,validator' && /architect's plan/.test(row('reviewer').brief));
  check('the scribe waits for the architect and the reviewer', (row('scribe').dependsOnRoles ?? []).join() === 'architect,reviewer' && startsWhen(row('scribe')) === 'after architect and reviewer');
  check('bug fix and one agent run a developer, on their own tier and brief', presetById('bugfix').roles[1]?.role === 'developer' && presetById('bugfix').roles[1]?.model === 'sonnet' && /regression test/.test(presetById('bugfix').roles[1]!.brief) && presetById('single').roles[0]?.role === 'developer' && presetById('single').roles[0]?.brief === '');
  check('analysis keeps its id, label and brief; its writer is a scribe', presetById('analysis').label === 'analysis' && presetById('analysis').roles[1]?.role === 'scribe' && /Change documentation only/.test(presetById('analysis').roles[1]!.brief));
  check('no preset names a removed role', PRESETS.every((p) => p.roles.every((r) => !['builder', 'documenter', 'uiux'].includes(r.role))));

  const ids = BUILT_IN_PERSONAS.map((p) => p.id);
  check('builder, documenter and uiux are no longer built-ins, nor offered as roles', ['builder', 'documenter', 'uiux'].every((id) => !ids.includes(id) && !KNOWN_ROLES.includes(id)));
  check("Custom's first row is a developer", FIRST_ROLE.role === 'developer');
  const dev = personaFor(BUILT_IN_PERSONAS, 'developer')!;
  check('the developer persona is on sonnet; the validator persona tests what was built', dev.model === 'sonnet' && personaFor(BUILT_IN_PERSONAS, 'validator')?.description === 'Proves the change works: writes the missing tests, runs them all, reports what fails.');

  const old = JSON.stringify({ edits: { builder: { systemPrompt: 'Old builder.' }, documenter: { brief: 'Old docs.', name: 'documenter' }, uiux: { brief: 'Old ui.' } } });
  const moved = personasFrom(old);
  check('an edit to the builder is now the developer\'s', personaFor(moved, 'developer')?.systemPrompt === 'Old builder.' && isEdited(personaFor(moved, 'developer')!));
  check("an edit to the documenter is now the scribe's, under the scribe's name", personaFor(moved, 'scribe')?.brief === 'Old docs.' && personaFor(moved, 'scribe')?.name === 'scribe');
  check('an edit to uiux is dropped, and no removed persona comes back', moved.length === BUILT_IN_PERSONAS.length && !moved.some((p) => ['builder', 'documenter', 'uiux'].includes(p.id)));
  const both = personasFrom(JSON.stringify({ edits: { builder: { systemPrompt: 'Old builder.' }, developer: { systemPrompt: 'Mine.' } } }));
  check('an edit already under the new id wins', personaFor(both, 'developer')?.systemPrompt === 'Mine.');
  const saved = JSON.parse(withPersona(old, { ...personaFor(moved, 'reviewer')!, brief: 'Changed.' })) as { edits: Record<string, unknown> };
  check('the next save writes the setting without the removed ids', Object.keys(saved.edits).sort().join() === 'developer,reviewer,scribe', JSON.stringify(saved));

  const setup = parseSetups(JSON.stringify([{ name: 'old', roles: [
    { role: 'builder', brief: '', dependsOnRoles: [] },
    { role: 'docs', brief: '', dependsOnRoles: ['builder'], persona: 'documenter' },
    { role: 'ui', brief: '', dependsOnRoles: [], persona: 'uiux' },
    { role: 'plain', brief: '', dependsOnRoles: [], persona: '' },
  ], models: { builder: 'x.model' } }]))[0]!;
  check('a saved setup: a builder row runs as developer, keeping its name and what waits on it', setup.roles[0]?.role === 'builder' && setup.roles[0]?.persona === 'developer' && setup.roles[1]?.dependsOnRoles.join() === 'builder' && setup.models['builder'] === 'x.model');
  check('a documenter pick is now scribe; a uiux pick runs with no persona; none stays none', setup.roles[1]?.persona === 'scribe' && rowPersona(setup.roles[2]!, personasFrom(null)) === undefined && setup.roles[3]?.persona === '');
}

console.log('\n17 · one more agent in a running job, and removing one from its stack (Amendments 88, 89)');
{
  const ag = (id: string, role: string, o: Partial<Agent> = {}): Agent => ({
    id, jobId: 'j', projectId: 'p', role, model: 'us.anthropic.claude-opus-5-5', sdkSessionId: null, status: 'queued', blockMode: null,
    costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], startedAt: null, endedAt: null,
    autonomy: { mode: 'acceptEdits', allowedTools: ['Read', 'Glob', 'Grep'], disallowedTools: ['WebFetch', 'WebSearch', 'Bash(git push:*)'], budgetUsd: 25, effort: 'high' },
    ...o,
  });
  const reads: Agent['autonomy'] = { mode: 'default', allowedTools: ['Read', 'Glob', 'Grep'], disallowedTools: ['WebFetch', 'WebSearch', ...WRITE_TOOLS], budgetUsd: 10 };
  const arch = ag('a', 'architect', { status: 'done', sdkSessionId: 's1' });
  const dev = ag('d', 'developer', { status: 'working', sdkSessionId: 's2', dependsOn: ['a'] });
  const val = ag('v', 'validator', { dependsOn: ['d'] });
  const rev = ag('r', 'reviewer', { dependsOn: ['d', 'v'], autonomy: reads });
  const scr = ag('s', 'scribe', { dependsOn: ['r'] });
  const job = [arch, dev, val, rev, scr];

  check('removing the reviewer: the scribe waits for what it waited for', rewirePreview(job, 'r') === 'scribe will wait for developer and validator instead.', rewirePreview(job, 'r'));
  check('removing the developer moves two, and one of them can start', rewirePreview(job, 'd') === 'validator will start: architect is done. reviewer will wait for architect and validator instead.', rewirePreview(job, 'd'));
  check('an agent nobody waits for moves nobody', rewirePreview(job, 's') === '');
  check(
    'one paused because this one was stopped will start; one paused by you stays paused',
    rewirePreview([ag('x', 'architect', { status: 'stopped' }), ag('y', 'developer', { status: 'paused', dependsOn: ['x'] })], 'x') === 'developer will start, waiting for no one.' &&
      rewirePreview([ag('x', 'architect', { status: 'done' }), ag('y', 'developer', { status: 'paused', dependsOn: ['x'] })], 'x') === 'developer stays paused, and will wait for no one.',
  );

  check('it can wait for any agent here but a stopped one or a helper', waitOptions([...job, ag('h', 'developer-helper-1', { parentId: 'd' }), ag('z', 'tester', { status: 'stopped' })]).map((a) => a.role).join() === 'architect,developer,validator,reviewer,scribe');
  check('and feed only the ones that have not started', feedOptions(job).map((a) => a.role).join() === 'validator,reviewer,scribe');
  check("the job's engine is its agents'", jobEngine(job) === CLAUDE && jobEngine([ag('o', 'developer', { provider: 'openrouter' })]) === 'openrouter');

  const draft = (o: Partial<AddDraft> = {}): AddDraft => ({ role: 'tester', brief: '', dependsOnRoles: ['developer'], feeds: ['scribe'], model: 'us.anthropic.claude-sonnet-5-5', budget: '5', ...o });
  check('a sound draft has no problems', addAgentProblems(draft(), job, true).length === 0, addAgentProblems(draft(), job, true).join(' | '));
  const said = (o: Partial<AddDraft>, usd = true): string => addAgentProblems(draft(o), job, usd).join(' | ');
  check('a role already in the job is a problem', /scribe is already in this job/.test(said({ role: 'scribe', feeds: [] })));
  check('so is a role that is not a role', /lowercase letters/.test(said({ role: 'Tester!' })));
  check('so is feeding one that has started', /developer has already started/.test(said({ dependsOnRoles: [], feeds: ['developer'] })));
  check('so is a loop', /a loop nothing could start/.test(said({ dependsOnRoles: ['scribe'], feeds: ['validator'] })), said({ dependsOnRoles: ['scribe'], feeds: ['validator'] }));
  check('so is waiting for a stopped one', /won't finish/.test(addAgentProblems(draft({ dependsOnRoles: ['tester0'] }), [...job, ag('t0', 'tester0', { status: 'stopped' })], true).join()));
  check('and a missing model or cap: every agent has one of its own', /Pick a model/.test(said({ model: '' })) && /budget in dollars/.test(said({ budget: '' })) && /budget in tokens/.test(said({ budget: '' }, false)));
  check('a token cap reads as typed', parseCap('500k', false) && 'tokens' in parseCap('500k', false) && (parseCap('500k', false) as { tokens: number }).tokens === 500_000);

  const spec = addAgentSpec(draft({ brief: '  Test the change.  ' }), job, undefined, true);
  check(
    'the request: role, model, brief, waits and feeds, the job’s permissions and its own cap',
    spec.role === 'tester' && spec.model === 'us.anthropic.claude-sonnet-5-5' && spec.brief === 'Test the change.' && spec.dependsOnRoles?.join() === 'developer' &&
      spec.feeds?.join() === 'scribe' && spec.autonomy.mode === 'acceptEdits' && spec.autonomy.budgetUsd === 5 && spec.provider === undefined,
    JSON.stringify(spec),
  );
  const reviewer = addAgentSpec(draft({ role: 'auditor', feeds: [] }), job, undefined, true);
  check(
    'a reading role is pinned read-only, as Spawn pins one, and the daemon would take it',
    reviewer.autonomy.mode === 'default' && WRITE_TOOLS.every((t) => reviewer.autonomy.disallowedTools.includes(t)) && readOnlyRefusal('auditor', reviewer.autonomy) === null,
    JSON.stringify(reviewer.autonomy),
  );
  const writerFromReaders = addedAutonomy([rev], 'developer', undefined, { usd: 3 });
  check('a writer added to a job of readers gets Spawn’s defaults, not a reader’s pin', writerFromReaders.mode === 'acceptEdits' && !writerFromReaders.disallowedTools.includes('Edit'), JSON.stringify(writerFromReaders));
  const qa = personaFor(BUILT_IN_PERSONAS, 'reviewer')!;
  const viaPersona = addAgentSpec(draft({ role: 'checker', feeds: [] }), job, { ...qa, tools: { ...qa.tools, write: false } }, true);
  check('a reading persona pins it too, and its prompt and id go with it', WRITE_TOOLS.every((t) => viaPersona.autonomy.disallowedTools.includes(t)) && viaPersona.persona === 'reviewer' && viaPersona.brief === qa.brief.trim());
  const onRouter = [ag('o', 'developer', { provider: 'openrouter', autonomy: { ...dev.autonomy, budgetUsd: null, budgetTokens: 2_000_000 } })];
  const routed = addAgentSpec(draft({ dependsOnRoles: ['developer'], feeds: [], model: 'openai/gpt-5', budget: '1M' }), onRouter, undefined, false);
  check('on another engine: its provider, and a cap in tokens, never dollars', routed.provider === 'openrouter' && routed.autonomy.budgetTokens === 1_000_000 && routed.autonomy.budgetUsd === null, JSON.stringify(routed.autonomy));
  check('its cap field starts at a sibling’s', budgetDefault(job, 'tester', true) === '25' && budgetDefault(onRouter, 'tester', false) === '2000000');
  check('the shared list says which roles read, for Spawn and the daemon alike', isReadOnlyRole('reviewer') && !isReadOnlyRole('scribe'));
}

console.log('\n18 · move rows in Spawn to set who each agent waits for (Amendment 99)');
{
  type Row = { role: string; dependsOnRoles?: string[] };
  const show = (rows: readonly Row[]): string => rows.map((r) => `${r.role}[${(r.dependsOnRoles ?? []).join('+')}]`).join(' ');
  const rows = (...specs: string[]): Row[] =>
    specs.map((x) => {
      const [role, deps = ''] = x.split(':');
      return { role: role!, dependsOnRoles: deps ? deps.split('+') : [] };
    });
  const full = presetById('full');
  const before = JSON.stringify(PRESETS);
  const fullShown = 'architect[] developer[architect] validator[developer] reviewer[architect+developer+validator] scribe[architect+reviewer]';

  check('the full pipeline, as shipped, reads as expected', show(full.roles) === fullShown, show(full.roles));
  check('by default every row waits for the one directly above it, and the first for none', show(chain(full.roles)) === 'architect[] developer[architect] validator[developer] reviewer[validator] scribe[reviewer]', show(chain(full.roles)));
  check(
    'the architect, developer and validator are on that default; the reviewer and the scribe, waiting on several, are not',
    [0, 1, 2].every((i) => onDefault(full.roles, i)) && !onDefault(full.roles, 3) && !onDefault(full.roles, 4),
  );
  check('a row may wait only for the rows above it', rolesAbove(full.roles, 3).join() === 'architect,developer,validator' && rolesAbove(full.roles, 0).length === 0);

  // Moving a row.
  const down = moveRow(full.roles, 3, 4);
  check(
    "moved within bounds, the reviewer keeps all three ticks; the scribe loses the one that now points below it",
    show(down) === 'architect[] developer[architect] validator[developer] scribe[architect] reviewer[architect+developer+validator]',
    show(down),
  );
  const up = moveRow(full.roles, 3, 1);
  check(
    'moved up to the second place, the reviewer keeps the tick still above it and drops the two now below; the rows it passed follow the chain',
    show(up) === 'architect[] reviewer[architect] developer[reviewer] validator[developer] scribe[architect+reviewer]',
    show(up),
  );
  const top = moveRow(full.roles, 3, 0);
  check(
    'moved to the top, every tick of the reviewer points below it and goes; the architect then waits for it',
    show(top) === 'reviewer[] architect[reviewer] developer[architect] validator[developer] scribe[architect+reviewer]',
    show(top),
  );
  const swap = moveRow(full.roles, 0, 1);
  check(
    'the architect moved below the developer: the developer starts, the architect waits for it, the validator waits for the row above it now',
    show(swap) === 'developer[] architect[developer] validator[architect] reviewer[architect+developer+validator] scribe[architect+reviewer]',
    show(swap),
  );
  check('moving a row away and back puts the preset as it was', sameStack(moveRow(swap, 1, 0), full.roles), show(moveRow(swap, 1, 0)));
  check("but a tick that was dropped isn't remembered: the scribe's wait for the reviewer stays gone", !sameStack(moveRow(down, 4, 3), full.roles) && show(moveRow(down, 4, 3)).endsWith('scribe[architect]'), show(moveRow(down, 4, 3)));
  check('the bug fix: the developer moved above the debugger starts, and the debugger waits for it', show(moveRow(presetById('bugfix').roles, 1, 0)) === 'developer[] debugger[developer]', show(moveRow(presetById('bugfix').roles, 1, 0)));

  const loose = rows('a', 'b:a', 'c:b', 'x:b');
  check('a row that waits on its own pick, not the one above, keeps it', !onDefault(loose, 3));
  check('left with nothing above that it waited for, it waits for the one directly above it', show(moveRow(loose, 3, 1)) === 'a[] x[a] b[x] c[b]', show(moveRow(loose, 3, 1)));
  check('a row set to wait for no one stays parallel when others move', show(moveRow(rows('a', 'b', 'c:b'), 2, 0)) === 'c[] a[c] b[]', show(moveRow(rows('a', 'b', 'c:b'), 2, 0)));
  check('no move, or one out of range, changes nothing', show(moveRow(full.roles, 2, 2)) === fullShown && show(moveRow(full.roles, 0, 9)) === fullShown && show(moveRow(full.roles, -1, 1)) === fullShown);
  check('recheckWaits drops a tick at a row below, at itself or at no row', show(recheckWaits(rows('a:b', 'b:b+a+zzz', 'c:b'))) === 'a[] b[a] c[b]', show(recheckWaits(rows('a:b', 'b:b+a+zzz', 'c:b'))));

  // Ticking.
  check('ticking a row above adds a wait, kept in the stack order, not the click order', show(toggleWait(rows('a', 'b:a', 'c'), 2, 'b')) === 'a[] b[a] c[b]' && show(toggleWait(toggleWait(rows('a', 'b', 'c'), 2, 'b'), 2, 'a')) === 'a[] b[] c[a+b]');
  check('unticking removes one', show(toggleWait(full.roles, 3, 'architect')) === show(full.roles).replace('reviewer[architect+developer+validator]', 'reviewer[developer+validator]'));
  check("a row below, or the row itself, can't be ticked", show(toggleWait(full.roles, 1, 'validator')) === fullShown && show(toggleWait(full.roles, 1, 'developer')) === fullShown);

  // Whichever way a row is moved, what comes out is a launch the daemon takes (Amendment 98).
  let broke = '';
  const everyMove: Array<{ id: string; roles: Row[] }> = [
    ...PRESETS.map((p) => ({ id: p.id, roles: p.roles as Row[] })),
    { id: 'loose', roles: loose },
  ];
  for (const { id, roles } of everyMove) {
    for (let from = 0; from < roles.length; from += 1) {
      for (let to = 0; to < roles.length; to += 1) {
        const moved = moveRow(roles, from, to);
        const named = moved.map((r) => r.role).sort().join();
        if (named !== roles.map((r) => r.role).sort().join()) broke ||= `${id} ${from}→${to}: roles changed`;
        moved.forEach((r, i) => {
          const above = moved.slice(0, i).map((x) => x.role);
          if ((r.dependsOnRoles ?? []).some((d) => !above.includes(d))) broke ||= `${id} ${from}→${to}: ${r.role} waits for one not above it`;
          const was = roles.find((x) => x.role === r.role)?.dependsOnRoles ?? [];
          if (i > 0 && was.length > 0 && (r.dependsOnRoles ?? []).length === 0) broke ||= `${id} ${from}→${to}: ${r.role} was waiting and now waits for no one`;
        });
      }
    }
  }
  check('after any move of any preset, every row waits only for rows above it, none is lost, and none that waited is left waiting for no one', broke === '', broke);

  // For this launch only.
  const arranged = { ...full, roles: swap as typeof full.roles };
  const specs = toAgentSpecs(arranged, defaultPills(), 5, undefined, {}, { opus: 'o', sonnet: 's', haiku: 'h' });
  check(
    'the launch is sent in the new order with the new waits',
    specs.map((a) => a.role).join() === 'developer,architect,validator,reviewer,scribe' &&
      specs[0]!.dependsOnRoles?.join() === '' && specs[1]!.dependsOnRoles?.join() === 'developer' && specs[2]!.dependsOnRoles?.join() === 'architect',
    JSON.stringify(specs.map((a) => [a.role, a.dependsOnRoles])),
  );
  check('and every agent of it waits only for one listed before it, as the daemon requires', specs.every((a, i) => (a.dependsOnRoles ?? []).every((d) => specs.slice(0, i).some((x) => x.role === d))));
  check('the preset itself is untouched: same order, same waits, same object', JSON.stringify(PRESETS) === before && presetById('full') === full && show(full.roles) === fullShown);
  check('and so is a row object a move passed', moveRow(full.roles, 0, 1)[0] !== full.roles[0] && full.roles[1]!.dependsOnRoles?.join() === 'architect');
  check('a launch with the preset unmoved is what it always was', toAgentSpecs(full, defaultPills(), 5, undefined, {}, { opus: 'o', sonnet: 's', haiku: 'h' }).map((a) => `${a.role}:${a.dependsOnRoles?.join('+')}`).join() === 'architect:,developer:architect,validator:developer,reviewer:architect+developer+validator,scribe:architect+reviewer');

  // A Custom setup moves the same way, and a new row waits for the one above it.
  const setup: CustomRole[] = [
    { role: 'architect', brief: '', dependsOnRoles: [] },
    { role: 'developer', brief: '', dependsOnRoles: ['architect'] },
    { role: 'validator', brief: '', dependsOnRoles: ['developer'] },
  ];
  check('a new Custom row waits for the row above it; the first waits for none', addRow(setup).at(-1)?.dependsOnRoles.join() === 'validator' && addRow([FIRST_ROLE])[1]?.dependsOnRoles.join() === 'developer' && addRow([]).at(-1)?.dependsOnRoles.length === 0);
  let bad = '';
  for (let from = 0; from < setup.length; from += 1) {
    for (let to = 0; to < setup.length; to += 1) {
      const problems = customProblems(moveRow(setup, from, to));
      if (problems.length > 0) bad ||= `${from}→${to}: ${problems.join(' ')}`;
    }
  }
  check('a Custom setup moved any way still has no problems, and the persona and brief go with each row', bad === '' && moveRow([{ ...setup[0]!, brief: 'Plan it.', persona: 'architect' }, setup[1]!], 0, 1)[1]?.brief === 'Plan it.' && moveRow([{ ...setup[0]!, persona: 'architect' }, setup[1]!], 0, 1)[1]?.persona === 'architect', bad);
  check('its preview keeps the moved order', toPreset('custom', 'c', moveRow(setup, 2, 0)).roles.map((r) => r.role).join() === 'validator,architect,developer');

  // The screen: the pieces are wired, and nothing is stored.
  const route = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  const custom = readFileSync(new URL('./CustomSetup.tsx', import.meta.url), 'utf8');
  const grip = readFileSync(new URL('./reorder.tsx', import.meta.url), 'utf8');
  const roleRow = readFileSync(new URL('./RoleRow.tsx', import.meta.url), 'utf8');
  check(
    "a change to a preset's rows is held in the screen's state only: it isn't written to a setting, and it doesn't make the preset Custom",
    /const arrange = \(roles: PresetRole\[\]\): void =>\s*setArranged\(sameStack\(roles, base\.roles\) \? null : \{ presetId, roles \}\);/.test(route) &&
      !/writeSetting\([^)]*arranged/.test(route) && !/setCustom\([^)]*arranged/.test(route),
  );
  check('choosing a preset puts its own rows back, and so does the button in the plan', /setPresetId\(id\);\s*setArranged\(null\);/.test(route) && /onClick=\{\(\) => setArranged\(null\)\}/.test(route));
  check('the Custom editor saves its own rows, not the plan', /withSetup\(saved, \{ name, roles: custom, models: ownPicks \}\)/.test(route));
  check(
    "the preset's plan rows show their waits for, with the same ticks a Custom row has",
    /<WaitsFor\s+who=\{r\.role\}\s+options=\{rolesAbove\(preset\.roles, i\)\}\s+waits=\{r\.dependsOnRoles \?\? \[\]\}\s+onToggle=\{\(on\) => arrange\(toggleWait\(preset\.roles, i, on\)\)\}/.test(route) &&
      /export function WaitsFor/.test(roleRow) && /<WaitsFor who=\{label\}/.test(roleRow),
  );
  check(
    'a Custom row has the buttons too, and a one-row setup or preset has none',
    /useReorder\(\(from, to\) => onChange\(moveRow\(roles, from, to\)\), roles\.length\)/.test(custom) && /roles\.length > 1 \? reorder\.handle/.test(custom) && /const movable = !isCustom && preset\.roles\.length > 1;/.test(route),
  );
  check(
    'a move works from the keyboard: two real buttons, named for the row, that follow it; the drag is native, from a grip',
    /<button\s+type="button"\s+className="sp-mvb"\s+data-move="up"/.test(grip) && /<button\s+type="button"\s+className="sp-mvb"\s+data-move="down"/.test(grip) && /aria-label=\{`Move \$\{name\} up`\}/.test(grip) && /aria-label=\{`Move \$\{name\} down`\}/.test(grip) &&
      /refocus\.current = \{ row:/.test(grip) && /draggable/.test(grip) && /e\.dataTransfer\.setData\(/.test(grip) && /disabled=\{i === 0\}/.test(grip),
  );
  const web = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  check('no drag library: React, shared, mermaid as before, and xterm for the terminal (Amendment 112)', Object.keys(web.dependencies).sort().join() === '@conductor/shared,@xterm/addon-fit,@xterm/xterm,mermaid,react,react-dom');

  // Both themes: the new rules use the measured tokens, and no colour of their own.
  const css = readFileSync(new URL('./spawn.css', import.meta.url), 'utf8');
  const mine = css.slice(css.indexOf('moving a row up or down the stack (Amendment 99)'));
  const vars = [...mine.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]!);
  const MEASURED = ['ink', 'ink2', 'ink3', 'line', 'line2', 'fs-sm', 'sans'];
  check('the move buttons, grip and drop mark use only tokens lib/verify.ts measures, and no hex', mine.length > 0 && !/#[0-9a-f]{3,8}\b/i.test(mine) && vars.every((v) => MEASURED.includes(v)), [...new Set(vars)].join());
  check('the grip and the note read as --ink3, which clears 4.5:1 in both themes', /\.sp-grip \{[^}]*color: var\(--ink3\)/.test(css) && /\.sp-plan-note \{[^}]*color: var\(--ink3\)/.test(css));
}

console.log('\n19 · a git methodology per launch, and two gaps in Spawn left by Amendment 99 (Amendment 115)');
{
  // The three choices, in the order they are numbered.
  check('three choices: the default branch in the folder, a branch you name, a new branch per launch', METHODS.map((m) => m.id).join() === 'in_place,named,worktree' && METHODS.length === 3);
  check("'branch in place' is no longer offered", !METHODS.some((m) => (m.id as string) === 'branch'));
  check('the git ones are marked as needing a repo; the folder as-is is not, and is the one drawn as a hazard', METHODS.filter((m) => m.requiresGit).map((m) => m.id).join() === 'named,worktree' && METHODS.find((m) => m.id === 'in_place')?.danger === true && !METHODS.some((m) => m.id !== 'in_place' && m.danger));
  check('what each sends: (1) in_place, (2) and (3) a worktree', isolationOf('in_place') === 'in_place' && isolationOf('named') === 'worktree' && isolationOf('worktree') === 'worktree');

  // The request body.
  const agents = toAgentSpecs(presetById('full'), defaultPills(), 5, undefined, {}, { sonnet: 'us.anthropic.claude-sonnet-5', opus: 'us.anthropic.claude-opus-4-1', haiku: 'h' });
  const base = { projectId: 'prj_1', prompt: '  do it \n', branch: '', preset: 'Full pipeline', agents, budgetUsd: 20 };
  const one = launchBody({ ...base, method: 'in_place' });
  check('(1) sends isolation in_place and no branch', one.isolation === 'in_place' && !('branch' in one), JSON.stringify(one).slice(0, 160));
  const two = launchBody({ ...base, method: 'named', branch: '  feature/refresh-tokens ' });
  check('(2) sends a worktree and the branch you named, trimmed', two.isolation === 'worktree' && two.branch === 'feature/refresh-tokens');
  const three = launchBody({ ...base, method: 'worktree', branch: 'left/over' });
  check('(3) sends a worktree and no branch, even with a name left in the field', three.isolation === 'worktree' && !('branch' in three));
  check('the rest of the body is what it was: the project, the trimmed prompt, the preset, the agents and the cap', [one, two, three].every((b) => b.projectId === 'prj_1' && b.prompt === 'do it' && b.preset === 'Full pipeline' && b.agents === agents && b.budgetUsd === 20));
  check('(1) and (3) are exactly the keys they were before this amendment', Object.keys(one).sort().join() === 'agents,budgetUsd,isolation,preset,projectId,prompt' && Object.keys(three).sort().join() === Object.keys(one).sort().join());

  // (2) needs a name.
  check('(2) cannot launch without a name, or with a blank one', !methodReady('named', '') && !methodReady('named', '   '));
  check('or with one git would refuse', ['two words', 'a..b', '-x', 'x.lock', 'x/', '/x', '@{-1}', 'HEAD', 'a~b'].every((n) => !methodReady('named', n)));
  check("or with the project's default branch", !methodReady('named', 'main', ['main']) && methodReady('named', 'main', ['develop']));
  check('with a good name it can', methodReady('named', 'feature/refresh-tokens') && methodReady('named', ' fix/123 '));
  check('(1) and (3) never wait for a name', methodReady('in_place', '') && methodReady('worktree', ''));
  check('an empty name asks for one; a bad one says what is wrong with it', branchProblem('') === 'Name the branch.' && /spaces/.test(branchProblem('a b') ?? '') && /default branch/.test(branchProblem('main', ['main']) ?? ''));

  // The same rule as git's, on a list of names. '@' and 'refs/…' pass git's own rule and are refused on purpose.
  const names = ['feature/x', 'a', 'a-b_c.d', 'fix/123', 'ä/ö', 'x.y', 'x/y', 'v1.2.3', 'wip', 'main', 'conductor/job_1', '', 'two words', 'a..b', '-x', '--evil', '@{-1}', 'HEAD', 'x.lock', 'a/b.lock', 'x/', '/x', 'x//y', '.x', 'a/.b', 'a@{b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a\tb', 'a.', 'a/b.', '@/x'];
  const git = (n: string): boolean => {
    try {
      return execFileSync('git', ['check-ref-format', '--branch', n], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === n && n.length > 0;
    } catch {
      return false;
    }
  };
  const disagree = names.filter((n) => git(n) !== (branchProblem(n) === null));
  check("the screen's check agrees with `git check-ref-format --branch` on every name", disagree.length === 0, JSON.stringify(disagree));
  check("'@' and a leading refs/ are refused here although git's rule lets them by", branchProblem('@') !== null && branchProblem('refs/heads/x') !== null);

  // The setting.
  check('the setting holds the values it always held for (1) and (3), and (2) is new', methodFrom('in_place') === 'in_place' && methodFrom('worktree') === 'worktree' && methodFrom('named') === 'named');
  check("and 'branch', which is not offered, or anything else, or nothing, reads as the built-in default", ['branch', 'moon', '', null].every((v) => methodFrom(v) === DEFAULT_METHOD) && DEFAULT_METHOD === 'worktree' && BUILT_IN.method === 'worktree');
  const dm = launchDefaults((k) => (k === LAUNCH_KEYS.isolation ? 'named' : null));
  check('choosing (2) as the default is kept, with no name: Spawn starts with it empty and will not launch', dm.method === 'named' && launchPatch(dm)[LAUNCH_KEYS.isolation] === 'named' && !Object.keys(dm).some((k) => /branch|name/i.test(k)) && !methodReady(dm.method, ''));
  check('the built-in default writes nothing', launchPatch({ ...BUILT_IN, method: 'worktree' })[LAUNCH_KEYS.isolation] === null && LAUNCH_KEYS.isolation === 'conductor.launch.isolation');

  // The screens.
  const route = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  const settings = readFileSync(new URL('../settings/route.tsx', import.meta.url), 'utf8');
  const wire = readFileSync(new URL('../../../shared/src/wire.ts', import.meta.url), 'utf8');
  check("Spawn's pills are the three choices", /\{METHODS\.map\(\(m, i\) => \{/.test(route) && /onClick=\{\(\) => setMethod\(m\.id\)\}/.test(route) && !/branch in place/.test(route) && !/const ISOLATIONS/.test(route));
  check('(2) shows a name field, and only (2)', /\{method === 'named' && \(\s*<div className="sp-branchrow">/.test(route) && /id="sp-branch"/.test(route));
  check('the launch waits for the name, and for nothing else new', /!customBad && methodOk;/.test(route) && /const methodOk = methodReady\(method, branchName, refused\);/.test(route));
  check("the project's default branch is among the names it will not take", /const refused = useMemo\(\(\) => \(selected \? \[selected\.defaultBranch\] : \[\]\), \[selected\]\);/.test(route));
  check('what is sent is launchBody, with the method and the name', /body: launchBody\(\{\s*projectId,\s*prompt,\s*method,\s*branch: branchName,/.test(route));
  check('a folder with no git moves the launch to (1), and back to what it had', /forced\.current = method;\s*setMethod\('in_place'\);/.test(route) && /setMethod\(back\);/.test(route));
  check('the name is cleared after a launch on it, as the prompt is: the branch is taken now', /if \(method === 'named'\) setBranchName\(''\);/.test(route));
  check('Settings offers the same three, and keeps the choice under the same key', /METHODS\.map\(\(m\) => \(/.test(settings) && /put\(\{ method: m\.id \}\)/.test(settings) && !/ISOLATION_WORDS/.test(settings));
  check('the wire already has the field, and says it goes with a worktree', /branch\?: string;/.test(wire) && /Only with `isolation: 'worktree'`/.test(wire));

  // Gap 1: removing a Custom row re-chains the rows that waited for it.
  const stack = [
    { role: 'architect', dependsOnRoles: [] as string[] },
    { role: 'developer', dependsOnRoles: ['architect'] },
    { role: 'validator', dependsOnRoles: ['developer'] },
    { role: 'reviewer', dependsOnRoles: ['validator'] },
  ];
  const waitsOf = (rows: { role: string; dependsOnRoles?: string[] }[]): string => rows.map((r) => `${r.role}<${(r.dependsOnRoles ?? []).join('+')}`).join(' ');
  check('removing a row in a chain: what waited for it now waits for the row above it', waitsOf(removeRow(stack, 2)) === 'architect< developer<architect reviewer<developer', waitsOf(removeRow(stack, 2)));
  check("removing the first row: what waited for it waits for no one, and the rest keep their chain", waitsOf(removeRow(stack, 0)) === 'developer< validator<developer reviewer<validator', waitsOf(removeRow(stack, 0)));
  check('removing the last row changes nothing else', waitsOf(removeRow(stack, 3)) === 'architect< developer<architect validator<developer');
  const fan = [
    { role: 'a', dependsOnRoles: [] as string[] },
    { role: 'b', dependsOnRoles: [] as string[] },
    { role: 'c', dependsOnRoles: ['a', 'b'] },
    { role: 'd', dependsOnRoles: ['b'] },
    { role: 'e', dependsOnRoles: ['a'] },
  ];
  check('a row that waited for it and others keeps the others; one that waited for exactly it waits for the row above; one that did not wait for it is left alone', waitsOf(removeRow(fan, 1)) === 'a< c<a d<a e<a', waitsOf(removeRow(fan, 1)));
  check('a row two above is untouched, and the removed row\'s own waits are not inherited', waitsOf(removeRow(stack, 1)) === 'architect< validator<architect reviewer<validator');
  check('out of range gives the rows back, and the original is never changed', waitsOf(removeRow(stack, 9)) === waitsOf(stack) && waitsOf(removeRow(stack, -1)) === waitsOf(stack) && stack[2]!.dependsOnRoles.join() === 'developer' && removeRow(stack, 1) !== stack);
  let bad = '';
  for (const rows of [stack, fan, presetById('full').roles, presetById('analysis').roles] as { role: string; dependsOnRoles?: string[] }[][]) {
    for (let i = 0; i < rows.length; i += 1) {
      const out = removeRow(rows, i);
      out.forEach((r, k) => {
        const above = out.slice(0, k).map((x) => x.role);
        if (!(r.dependsOnRoles ?? []).every((d) => above.includes(d))) bad ||= `${i}: ${waitsOf(out)}`;
      });
    }
  }
  check('whichever row goes, every wait points at a row above it, so the daemon takes it (Amendment 98)', bad === '', bad);
  const customStack: CustomRole[] = [
    { role: 'architect', brief: '', dependsOnRoles: [] },
    { role: 'developer', brief: '', dependsOnRoles: ['architect'] },
    { role: 'validator', brief: '', dependsOnRoles: ['developer'] },
  ];
  const cut = removeRole(customStack, 1);
  check('removeRole is that rule on a Custom setup, and the result still launches', cut.map((r) => `${r.role}<${r.dependsOnRoles.join()}`).join(' ') === 'architect< validator<architect' && customProblems(cut).length === 0 && customProblems(removeRole(customStack, 0)).length === 0);
  check("the editor's remove button calls it", /onRemove=\{\(\) => onChange\(removeRole\(roles, i\)\)\}/.test(readFileSync(new URL('./CustomSetup.tsx', import.meta.url), 'utf8')));

  // Gap 2: the preset label is honest.
  check('a preset launched as it is keeps its own name; a changed one says so', presetLabel('Full pipeline', false) === 'Full pipeline' && presetLabel('Full pipeline', true) === 'Full pipeline (changed)');
  const full = presetById('full');
  const labelFor = (rows: typeof full.roles): string => presetLabel(full.label, !sameStack(rows, full.roles));
  check('moving a row changes it, moving it back does not', labelFor(moveRow(full.roles, 0, 2)) === `${full.label} (changed)` && labelFor(moveRow(moveRow(full.roles, 0, 2), 2, 0)) === full.label);
  // validator waits for developer; ticking architect as well is a change, and unticking it again is not.
  const ticked = toggleWait(full.roles, 2, 'architect');
  check('so does a tick, and taking it back does not', ticked[2]?.dependsOnRoles?.join() === 'architect,developer' && labelFor(ticked) === `${full.label} (changed)` && labelFor(toggleWait(ticked, 2, 'architect')) === full.label);
  check('what is sent is that label; a Custom setup keeps its own name (it has no preset to differ from)', /preset: presetLabel\(preset\.label, changed\),/.test(route) && /const changed = !isCustom && !sameStack\(preset\.roles, base\.roles\);/.test(route));
}

console.log('\n20 · better instructions for the built-in roles (Amendment 126)');
{
  const ids = ['architect', 'developer', 'validator', 'reviewer', 'scribe', 'debugger', 'analyst'];
  const lastLine = (p: string): string => p.trimEnd().split('\n').at(-1) ?? '';
  check('there are seven built-ins, in that order', BUILT_IN_PERSONAS.map((p) => p.id).join() === ids.join());
  check(
    'every one has a system prompt, and it ends in an "End with:" line',
    BUILT_IN_PERSONAS.every((p) => p.systemPrompt.trim() !== '' && /^End with: /.test(lastLine(p.systemPrompt))),
    BUILT_IN_PERSONAS.filter((p) => !/^End with: /.test(lastLine(p.systemPrompt))).map((p) => p.id).join(),
  );
  check(
    'and that line says the headings are the summary of hand_off when the agent has the tool, and its last reply when it has not',
    BUILT_IN_PERSONAS.every((p) => /`hand_off` tool, that is its `summary`; otherwise it is your last reply\.$/.test(lastLine(p.systemPrompt))),
  );
  const HEADINGS: Record<string, string[]> = {
    architect: ['Context', 'Options', 'Decision', 'Consequences', 'Plan', 'Risks and open questions'],
    developer: ['Changed', 'How I checked', 'Departures from the plan', 'Left undone'],
    validator: ['Verdict', 'Checks', 'Failures', 'Not covered'],
    reviewer: ['Verdict', 'Findings', 'What I checked'],
    scribe: ['Updated', 'Corrected', 'Not documented, and why'],
    debugger: ['Symptom', 'Reproduction', 'Root cause', 'Evidence', 'Fix belongs at', 'Regression test', 'Confidence'],
    analyst: ['Overview', 'Map', 'Flows', 'Decisions encoded', 'Open questions', 'Not read'],
  };
  check(
    'each closes with its own headings, in bold and in order',
    ids.every((id) => {
      const line = lastLine(personaFor(BUILT_IN_PERSONAS, id)!.systemPrompt);
      const at = HEADINGS[id]!.map((h) => line.indexOf(`**${h}`));
      return at.every((n) => n >= 0) && at.every((n, i) => i === 0 || n > at[i - 1]!);
    }),
  );
  check('the reviewer ranks findings and the debugger names a regression test', /\*\*Findings\*\* \(ranked\)/.test(lastLine(personaFor(BUILT_IN_PERSONAS, 'reviewer')!.systemPrompt)) && /\*\*Regression test\*\* \(what it should assert\)/.test(lastLine(personaFor(BUILT_IN_PERSONAS, 'debugger')!.systemPrompt)));
  check(
    'a system prompt is a few hundred tokens, not a page',
    BUILT_IN_PERSONAS.every((p) => p.systemPrompt.length > 600 && p.systemPrompt.length < 3_000),
    BUILT_IN_PERSONAS.map((p) => `${p.id} ${p.systemPrompt.length}`).join(', '),
  );

  // The architect keeps what it had, plus one rule; its old rule about "your last reply" went with Amendment 101 and 104.
  const arch = personaFor(BUILT_IN_PERSONAS, 'architect')!;
  check('the architect keeps its rules and gains the one about its hand-off', /Evidence first/.test(arch.systemPrompt) && /AskUserQuestion/.test(arch.systemPrompt) && /don't write the implementation/.test(arch.systemPrompt) && /The developer starts from your hand-off, so make the plan stand alone: name every file/.test(arch.systemPrompt));
  check('and says nothing that is no longer so: the next agent is not given only your last reply', !/last reply is handed/i.test(arch.systemPrompt) && !/8,000/.test(BUILT_IN_PERSONAS.map((p) => p.systemPrompt).join('')));

  // Descriptions and briefs: said on screen, so short; and each limit that is only words is in the words.
  check('every description is one short line, and every brief says what to do', BUILT_IN_PERSONAS.every((p) => p.description.length > 20 && p.description.length < 100 && !/\n/.test(p.description) && p.brief.trim().length > 40));
  const sp = (id: string): string => personaFor(BUILT_IN_PERSONAS, id)!.systemPrompt;
  const br = (id: string): string => personaFor(BUILT_IN_PERSONAS, id)!.brief;
  check('the developer follows the plan, runs the checks, and does not commit, push or rewrite history unless told', /follow it/.test(br('developer')) && /Run the project's checks/.test(br('developer')) && /Don't commit, push or rewrite git history unless the job says to/.test(sp('developer')));
  check('the validator changes tests, not the code under test, and reports a bug it finds', /Change tests, not the code under test/.test(br('validator')) && /Change test files and fixtures only/.test(sp('validator')) && /don't fix it/.test(sp('validator')));
  check('the reviewer changes no files, reads the working tree as well as commits, and ranks', /Change no files/.test(br('reviewer')) && /Change no files/.test(sp('reviewer')) && /git status/.test(sp('reviewer')) && /git diff/.test(sp('reviewer')) && /blocker, should fix or nit/.test(sp('reviewer')));
  check('the scribe changes documentation only, and the code wins over the plan', /Change documentation only/.test(br('scribe')) && /Change documentation only/.test(sp('scribe')) && /source of truth/.test(sp('scribe')));
  check('the debugger and the analyst change no files; the debugger writes no fix, the analyst cites every claim', /Change no files/.test(br('debugger')) && /Don't change the project's files/.test(sp('debugger')) && /Don't write the fix/.test(sp('debugger')) && /Change no files/.test(sp('analyst')) && /Cite file and line for every claim/.test(sp('analyst')));

  // Tools and tiers are as they were, and push is the launch's: only the architect says anything about it.
  const shape = (id: string): string => { const p = personaFor(BUILT_IN_PERSONAS, id)!; return `${p.model} ${JSON.stringify(p.tools)}`; };
  check(
    'tiers and tool rules are unchanged: the reading roles write nothing, the rest leave it to the launch',
    shape('architect') === 'opus {"bash":true,"write":true,"network":true,"push":false}' && shape('developer') === 'sonnet {}' && shape('validator') === 'sonnet {}' && shape('scribe') === 'sonnet {}' &&
      shape('reviewer') === 'opus {"write":false}' && shape('debugger') === 'opus {"write":false}' && shape('analyst') === 'opus {"write":false}',
    ids.map(shape).join(' | '),
  );
  check('no built-in but the architect sets push', BUILT_IN_PERSONAS.every((p) => p.id === 'architect' || p.tools.push === undefined));

  // The three preset briefs that were aligned, and the ones that were not.
  const brief = (preset: string, role: string): string => presetById(preset).roles.find((r) => r.role === role)!.brief;
  check('the full stack\'s validator changes tests, not the code under test, and still tests against the plan', /Change tests, not the code under test/.test(brief('full', 'validator')) && /architect's plan/.test(brief('full', 'validator')) && /what the developer built/.test(brief('full', 'validator')));
  check('its reviewer reports findings with file and line, most severe first, and changes no files', /Report findings with file and line, most severe first\. Change no files\./.test(brief('full', 'reviewer')) && !/do not rewrite/.test(brief('full', 'reviewer')) && /architect's plan/.test(brief('full', 'reviewer')));
  check("the bug fix's developer adds the regression test the debugger describes, and shows it fails before the fix", /regression test it describes/.test(brief('bugfix', 'developer')) && /fails before your fix and passes after/.test(brief('bugfix', 'developer')) && /root cause the debugger identified/.test(brief('bugfix', 'developer')));
  check('the other presets\' briefs are as they were', brief('bugfix', 'debugger') === 'Find the root cause before proposing any fix. Report the cause with file and line evidence.' && brief('review', 'reviewer') === 'Review only. Report findings with file and line references. Change no files.' && brief('single', 'developer') === '' && /Change documentation only/.test(brief('analysis', 'scribe')) && /Change documentation only/.test(brief('analysis-only', 'scribe')));

  // The system prompt is the one field that reaches every stack, since a preset keeps its own brief.
  const every = personasFrom(null);
  check(
    'every preset sends each of its roles the persona\'s system prompt, so every agent in every stack is told how to close',
    PRESETS.every((p) => toAgentSpecs(p, PERMISSIVE, 5, undefined, {}, {}, {}, undefined, every).every((a) => a.systemPrompt === personaFor(every, a.persona ?? a.role)!.systemPrompt && /^End with: /.test(lastLine(a.systemPrompt ?? '')))),
  );
  check('and a Custom row of a built-in persona does too', toAgentSpecs(toPreset('custom', 'x', [{ role: 'reviewer', brief: '', dependsOnRoles: [] }], every), PERMISSIVE, 5, undefined, {}, {}, {}, undefined, every)[0]!.systemPrompt === sp('reviewer'));
  check('a reading role is still pinned read-only with its new prompt', toAgentSpecs(presetById('full'), PERMISSIVE, 5, undefined, {}, {}, {}, undefined, every).find((a) => a.role === 'reviewer')!.autonomy.disallowedTools.includes('Write'));

  // No migration: an edit is kept, a built-in nobody edited is the new text, Reset gives it.
  const mine = withPersona(null, { ...personaFor(every, 'validator')!, brief: 'My own validator brief.' });
  const kept = personasFrom(mine);
  check(
    'someone who edited the validator\'s brief keeps it and gets the new system prompt; a built-in they never edited is the new text',
    personaFor(kept, 'validator')?.brief === 'My own validator brief.' && personaFor(kept, 'validator')?.systemPrompt === sp('validator') && personaFor(kept, 'reviewer')?.systemPrompt === sp('reviewer') && !isEdited(personaFor(kept, 'reviewer')!),
  );
  const theirs = withPersona(null, { ...personaFor(every, 'developer')!, systemPrompt: 'Prefer pure functions.' });
  check('someone who replaced a system prompt keeps theirs, and Reset gives them the new one', personaFor(personasFrom(theirs), 'developer')?.systemPrompt === 'Prefer pure functions.' && personaFor(personasFrom(resetPersona(theirs, 'developer')), 'developer')?.systemPrompt === sp('developer') && JSON.parse(mine).edits.validator && Object.keys(JSON.parse(mine).edits.validator).join() === 'brief');
}

console.log('\n21 · orchestrated stacks: one agent runs the others, with the roles it may start listed before launch (Amendment 128)');
{
  const tiersNow = { opus: 'us.anthropic.claude-opus-5', sonnet: 'us.anthropic.claude-sonnet-5', haiku: 'us.anthropic.claude-haiku-5' };
  const every = personasFrom(null);
  const orch = presetById(ORCHESTRATED_ID);
  const specsFor = (listed: readonly ListedRole[], personas = every, tiers = tiersNow) =>
    toAgentSpecs(orchestratedFor(orch, listed), PERMISSIVE, 5, undefined, {}, tiers, {}, undefined, personas, listed);

  check('there is a preset "orchestrated pipeline", beside the fixed ones', orch.id === 'orchestrated' && orch.label === 'orchestrated pipeline' && PRESETS.some((p) => p.id === 'full') && PRESETS.some((p) => p.id === 'orchestrated'));
  check('it is one row, the orchestrator: the architect persona on a strong model', orch.roles.length === 1 && orch.roles[0]!.role === 'orchestrator' && orch.roles[0]!.persona === 'architect' && orch.roles[0]!.model === 'opus' && orch.roles[0]!.orchestrates === true);
  check('and no other preset has an orchestrator row', PRESETS.filter((p) => p.id !== 'orchestrated').every((p) => !p.orchestrated && p.roles.every((r) => !r.orchestrates)));
  check('its brief says to run the steps one at a time, send work back and ask', /one role at a time/.test(orch.roles[0]!.brief) && /Send work back/.test(orch.roles[0]!.brief) && /ask the user/.test(orch.roles[0]!.brief));

  // The roles it may start, before launch.
  const defaults = defaultListed(every);
  check('the roles listed are developer, validator, reviewer and scribe, each on its persona\'s tier', defaults.map((r) => `${r.id}:${r.tier}`).join() === 'developer:sonnet,validator:sonnet,reviewer:opus,scribe:sonnet');
  check('as the full pipeline has their tiers', defaults.every((r) => presetById('full').roles.find((x) => x.role === r.id)!.model === r.tier));
  check('a persona edited to another tier moves its role', defaultListed(personasFrom(withPersona(null, { ...personaFor(every, 'scribe')!, model: 'haiku' }))).find((r) => r.id === 'scribe')?.tier === 'haiku');
  check('with no personas loaded, the built-ins\' tiers', defaultListed().map((r) => r.tier).join() === 'sonnet,sonnet,opus,sonnet');

  const specs = specsFor(defaults);
  check('one agent is launched: the orchestrator, as the architect', specs.length === 1 && specs[0]!.role === 'orchestrator' && specs[0]!.persona === 'architect' && specs[0]!.systemPrompt === personaFor(every, 'architect')!.systemPrompt);
  const o = specs[0]!;
  check('it may start helpers enough for each role once and sent back twice: 4 roles × 3', o.helpers === 12 && o.helpers === helperCapFor(defaults) && o.helpers === pipelineHelperCap(4));
  check('and carries the roles in the launch request', o.helperRoles?.map((r) => r.id).join() === 'developer,validator,reviewer,scribe', JSON.stringify(o.helperRoles?.map((r) => r.id)));
  const role = (id: string) => o.helperRoles!.find((r) => r.id === id)!;
  check('each with the model its tier means now', role('developer').model === tiersNow.sonnet && role('reviewer').model === tiersNow.opus && role('developer').tier === 'sonnet' && role('reviewer').tier === 'opus');
  check("and its persona's system prompt, brief and skills", role('developer').systemPrompt === personaFor(every, 'developer')!.systemPrompt && role('developer').brief === personaFor(every, 'developer')!.brief.trim() && /^End with: /.test(role('validator').systemPrompt!.trimEnd().split('\n').at(-1) ?? ''));
  check('and what every tier meant at launch, so it can ask for a cheaper one', JSON.stringify(role('developer').tiers) === JSON.stringify(tiersNow));
  check('a reading role is pinned read-only whatever the pills: write tools denied, no shell, not auto-approved', WRITE_TOOLS.every((t) => role('reviewer').autonomy.disallowedTools.includes(t)) && role('reviewer').autonomy.mode !== 'acceptEdits' && !role('reviewer').autonomy.allowedTools.includes('Bash') && readOnlyRefusal('reviewer', role('reviewer').autonomy) === null);
  check('a writing role is as it is in any stack', !role('developer').autonomy.disallowedTools.includes('Write') && role('developer').autonomy.budgetUsd === 5);
  check('each role is launched exactly as the same role is in the full pipeline', ['developer', 'reviewer', 'validator', 'scribe'].every((id) => {
    const inFull = toAgentSpecs(presetById('full'), PERMISSIVE, 5, undefined, {}, tiersNow, {}, undefined, every).find((x) => x.role === id)!;
    return JSON.stringify(role(id).autonomy) === JSON.stringify(inFull.autonomy) && role(id).systemPrompt === inFull.systemPrompt && role(id).model === inFull.model;
  }));
  check('the orchestrator itself is not a reading role: it can write the plan', !o.autonomy.disallowedTools.includes('Write'));

  // The request body.
  const body = launchBody({ projectId: 'p', prompt: 'Build it.', method: 'worktree', branch: '', preset: presetLabel(orch.label, false), agents: specs, budgetUsd: jobBudgetUsd(5, specs.length, ALL_ON) });
  const wire = JSON.parse(JSON.stringify(body)) as { agents: { helpers?: number; helperRoles?: { id: string; model: string }[] }[]; preset: string };
  check('the launch request carries the roles and the helper cap', wire.preset === 'orchestrated pipeline' && wire.agents[0]!.helpers === 12 && wire.agents[0]!.helperRoles!.length === 4 && wire.agents[0]!.helperRoles![0]!.model === tiersNow.sonnet);
  check('an ordinary launch sends neither', ['full', 'bugfix', 'review', 'analysis', 'single'].every((id) => {
    const j = JSON.stringify(toAgentSpecs(presetById(id), PERMISSIVE, 5, undefined, {}, tiersNow, {}, undefined, every, defaults));
    return !j.includes('helperRoles') && !j.includes('"helpers"');
  }));

  // Editable, like the other plan rows.
  const noReviewer = withoutRole(defaults, 'reviewer');
  const lighter = withTier(noReviewer, 'developer', 'haiku');
  const s2 = specsFor(lighter)[0]!;
  check('a role can be removed: it is not listed, and the cap follows', s2.helperRoles?.map((r) => r.id).join() === 'developer,validator,scribe' && s2.helpers === 9);
  check('a tier can be changed: the model follows it, and the others are as they were', s2.helperRoles?.find((r) => r.id === 'developer')?.model === tiersNow.haiku && s2.helperRoles?.find((r) => r.id === 'developer')?.tier === 'haiku' && s2.helperRoles?.find((r) => r.id === 'validator')?.model === tiersNow.sonnet);
  check('a role can be added, on its persona\'s tier, at the end', withRole(defaults, 'debugger', every).at(-1)?.id === 'debugger' && withRole(defaults, 'debugger', every).at(-1)?.tier === 'opus' && specsFor(withRole(defaults, 'debugger', every))[0]!.helpers === 15);
  check('a debugger it may start is read-only too', WRITE_TOOLS.every((t) => specsFor(withRole(defaults, 'debugger', every))[0]!.helperRoles!.find((r) => r.id === 'debugger')!.autonomy.disallowedTools.includes(t)));
  check('but not one twice', withRole(defaults, 'developer', every).length === 4 && withRole(defaults, 'developer', every).map((r) => r.id).join() === 'developer,validator,reviewer,scribe');
  check('nor more than eight', withRole(Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, tier: 'sonnet' as const })), 'architect', every).length === 8);
  check('what is left to add is every persona not listed', offeredRoles(defaults, every).map((p) => p.id).join() === 'architect,debugger,analyst' && offeredRoles([], every).length === every.length);
  check('the list is this launch\'s only: the default is untouched by an edit', defaultListed(every).length === 4 && defaults.length === 4 && noReviewer.length === 3);
  check('a tier with no model served blocks the launch, and names the role', unresolvedListed(defaults, { opus: tiersNow.opus, sonnet: tiersNow.sonnet }).map((r) => r.id).join() === '' && unresolvedListed(lighter, { opus: tiersNow.opus, sonnet: tiersNow.sonnet }).map((r) => r.id).join() === 'developer');

  // One agent needs no orchestrator.
  check('with every role removed it is one agent, and one agent has no orchestrator', !orchestrates([]) && !showsOrchestrator(stackAgents([])) && orchestrates(withoutRole(withoutRole(withoutRole([{ id: 'developer', tier: 'sonnet' }, { id: 'scribe', tier: 'sonnet' }], 'developer'), 'scribe'), 'x')) === false);
  const lone = orchestratedFor(orch, []);
  check('the preset then launches that one agent plainly: the architect row, no orchestrator, no list', lone.roles.length === 1 && lone.roles[0]!.role === 'architect' && !lone.roles[0]!.orchestrates && !lone.orchestrated && lone.roles[0]!.persona === undefined);
  const plain = specsFor([])[0]!;
  check('and its spec has no helpers and no roles, so nothing orchestrates', specsFor([]).length === 1 && plain.role === 'architect' && !('helpers' in plain) && !('helperRoles' in plain) && !JSON.stringify(plain).includes('orchestrat'), JSON.stringify(plain));
  check('and is the full pipeline\'s architect: its brief, its tier, its persona', plain.brief === presetById('full').roles[0]!.brief && plain.model === tiersNow.opus && plain.persona === 'architect');
  check('one role listed is two agents, so there is an orchestrator after all', orchestrates([{ id: 'developer', tier: 'sonnet' }]) && showsOrchestrator(stackAgents([{ id: 'developer', tier: 'sonnet' }])) && specsFor([{ id: 'developer', tier: 'sonnet' }])[0]!.helpers === 3 && orchestratedFor(orch, [{ id: 'developer', tier: 'sonnet' }]) === orch);
  check('a preset that is not orchestrated is returned as it is', orchestratedFor(presetById('full'), []) === presetById('full') && orchestratedFor(presetById('single'), defaults) === presetById('single'));
  check('the preset is not changed by launching it plain', orchestratedFor(orch, []) !== orch && orch.roles[0]!.role === 'orchestrator' && orch.orchestrated === true);

  // Without a persona in hand, or off Claude.
  const bare = toAgentSpecs(orchestratedFor(orch, defaults), PERMISSIVE, 5, undefined, {}, tiersNow, {}, undefined, undefined, defaults)[0]!;
  check('without personas the roles are listed with no prompts, still read-only where they read', bare.helperRoles!.length === 4 && bare.helperRoles!.every((r) => !('systemPrompt' in r)) && WRITE_TOOLS.every((t) => bare.helperRoles!.find((r) => r.id === 'reviewer')!.autonomy.disallowedTools.includes(t)));
  const copilotCaps: Capabilities = { defer: false, resume: true, costUsd: false, effort: true, planMode: false, helperTools: true };
  const on = specsOn(specs, { provider: 'copilot', caps: copilotCaps, model: 'gpt-5', budgetTokens: 500_000 });
  check('off Claude every role runs on the launch\'s one model, in tokens, with no tiers', on[0]!.helperRoles!.every((r) => r.model === 'gpt-5' && !('tier' in r) && !('tiers' in r) && r.autonomy.budgetUsd === null && r.autonomy.budgetTokens === 500_000) && on[0]!.helpers === 12);
  check('and a reading role there is still read-only', WRITE_TOOLS.every((t) => on[0]!.helperRoles!.find((r) => r.id === 'reviewer')!.autonomy.disallowedTools.includes(t)));
  const none = specsOn(specs, { provider: 'copilot', caps: NONE, model: 'gpt-5', budgetTokens: null });
  check('an engine that cannot start helpers is sent neither the helpers nor the roles', !('helpers' in none[0]!) && !('helperRoles' in none[0]!));
  check('a Claude launch is the very same specs', specsOn(specs, { provider: CLAUDE, caps: ALL_ON, model: '', budgetTokens: null }) === specs);

  // What Spawn shows.
  const route = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  check('Spawn lists the roles under the row, and marks the orchestrator only on that row', /listsRoles && i === 0 && \(\s*<Pipeline/.test(route) && /\{r\.orchestrates && <OrchestratorMark \/>\}/.test(route) && /\$\{r\.orchestrates \? ' is-orch' : ''\}/.test(route));
  check('the row\'s "+ up to N helpers" is not offered on it, nor on the lone architect it becomes: the list sets the cap, and one agent has no orchestrator affordance', /has\.helpers && !r\.orchestrates && !listsRoles/.test(route));
  check('the list is state of this launch: a preset change puts the default back', /setListedEdit\(null\)/.test(route) && /listedEdit \?\? defaultListed\(personas\)/.test(route));
  check('an engine that cannot start helpers lists none', /has\.helpers \? \(listedEdit \?\? defaultListed\(personas\)\) : \[\]/.test(route));
  check('a launch waits for a tier with no model, as it does for a row', /missingListed\.length === 0/.test(route) && /unresolvedListed\(listed, tiers\)/.test(route));
  const picker = readFileSync(new URL('./Pipeline.tsx', import.meta.url), 'utf8');
  check('the list can remove a role, change a tier and add one, and says how work is sent back', /withoutRole\(listed, l\.id\)/.test(picker) && /withTier\(listed, l\.id/.test(picker) && /withRole\(listed, e\.target\.value/.test(picker) && /sendBackWords\(\)/.test(picker));
  check('a stack of one says it is one agent, with no orchestrator', /No role listed, so this launches one architect agent and nothing orchestrates/.test(picker));
  check('the words say what the daemon enforces: twice a role, then it asks', /at most 2 times, then it asks you/.test(sendBackWords()));

  // Both themes: the new rules use the measured tokens, and no colour of their own, and no status colour.
  const css = readFileSync(new URL('./spawn.css', import.meta.url), 'utf8');
  const mine = css.slice(css.indexOf('an orchestrated stack (Amendment 128)'), css.indexOf('moving a row up or down the stack (Amendment 99)'));
  const vars = [...mine.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]!);
  const STATUS = ['live', 'need', 'fail', 'done', 'you', 'queue', 'idle'];
  check('the orchestrator\'s plan rules use ink and line tokens only: no hex, and not --live, --done, --need, --fail or --you', mine.length > 0 && !/#[0-9a-f]{3,8}\b/i.test(mine) && vars.every((v) => !STATUS.includes(v)) && ['ink2', 'line2'].every((v) => vars.includes(v)), [...new Set(vars)].join());
}

console.log(
  failures === 0
    ? '\nTrack A spawn: PASS — presets resolve, each role takes its own model, launch defaults are read, custom setups hold together, presets and Custom rows take their personas, a reading role cannot write, and a launch on another engine sends its provider, its model and a cap in its own unit while a Claude launch is unchanged; and a row moves up or down a stack, its waits following it; and a launch picks its git methodology, a removed row re-chains what waited for it, and a changed preset says so.\n'
    : `\nTrack A spawn: FAIL — ${failures} check(s) failed.\n`,
);process.exit(failures === 0 ? 0 : 1);
