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

import { MODEL_NICKNAMES, type ModelCatalog } from '@conductor/shared';
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
import { FIRST_ROLE, KNOWN_ROLES, customProblems, nextRole, parseSetups, personaPicks, removeRole, renameRole, roleFromName, rowPersona, toPreset, withSetup, withoutSetup, type CustomRole } from './custom.js';
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
} from './presets.js';

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
    [LAUNCH_KEYS.isolation]: 'branch',
    [LAUNCH_KEYS.pills]: JSON.stringify({ allowBash: true, nonsense: true, network: 'yes' }),
    [LAUNCH_KEYS.budget]: '',
    [LAUNCH_KEYS.effort]: 'low',
    [LAUNCH_KEYS.model]: ' us.anthropic.claude-sonnet-5 ',
  };
  const d = launchDefaults((k) => kept[k] ?? null);
  check('each one set is read', d.preset === 'analysis' && d.isolation === 'branch' && d.effort === 'low' && d.budget === '' && d.model === 'us.anthropic.claude-sonnet-5', JSON.stringify(d));
  check('only real pills, only as booleans; the rest keep their default', d.pills['allowBash'] === true && !('nonsense' in d.pills) && d.pills['network'] === false && d.pills['acceptEdits'] === true, JSON.stringify(d.pills));
  const bad = launchDefaults((k) => ({ [LAUNCH_KEYS.preset]: 'gone', [LAUNCH_KEYS.isolation]: 'moon', [LAUNCH_KEYS.effort]: 'huge', [LAUNCH_KEYS.budget]: '-3', [LAUNCH_KEYS.pills]: '{nope' } as Record<string, string>)[k] ?? null);
  check('a value that is not one reads as the default, so Spawn always opens', JSON.stringify(bad) === JSON.stringify(BUILT_IN), JSON.stringify(bad));
  const patch = launchPatch({ ...BUILT_IN, effort: 'low' });
  check('saving writes only what differs, and clears the rest', patch[LAUNCH_KEYS.effort] === 'low' && patch[LAUNCH_KEYS.preset] === null && patch[LAUNCH_KEYS.pills] === null && patch[LAUNCH_KEYS.model] === null, JSON.stringify(patch));
  check('the built-in defaults write nothing at all', Object.values(launchPatch(BUILT_IN)).every((v) => v === null), JSON.stringify(launchPatch(BUILT_IN)));
  const round = launchDefaults((k) => launchPatch(d)[k] ?? null);
  check('and what it writes reads back the same', JSON.stringify(round) === JSON.stringify(d), JSON.stringify(round));
  const src = readFileSync(new URL('./route.tsx', import.meta.url), 'utf8');
  check('Spawn reads them when it opens', /useState\(\(\) => launchDefaults\(readSetting\)\)/.test(src) && /useState<Isolation>\(start\.isolation\)/.test(src));
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
  check('Spawn sends the mode, and the plan button and edits pill are gone', /toAgentSpecs\(preset, pills, budgetPerAgent, effort, picks, tiers, helpers, mode(, personas)?\)/.test(src) && !/plan first, don't write code/.test(src) && !PILLS.some((p) => p.id === 'acceptEdits'));
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
  check('a persona with nothing to append sends no system prompt or skills', specs.find((x) => x.role === 'validator')?.persona === 'validator' && !('systemPrompt' in specs.find((x) => x.role === 'validator')!) && !('skills' in specs.find((x) => x.role === 'validator')!));
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
  check('Spawn reads the personas setting and hands it on', /personasFrom\(personasRaw\)/.test(src) && /useSetting\(PERSONAS_KEY\)/.test(src) && /mode, personas\)/.test(src) && /personas=\{personas\}/.test(src) && /personaPicks\(custom, personas\)/.test(src));
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
  check('Spawn sends the specs through specsOn, and the job cap through jobBudgetUsd', /specsOn\(toAgentSpecs\(preset, pills, budgetPerAgent, effort, picks, tiers, helpers, mode, personas\), launchOn\)/.test(src) && /budgetUsd: jobBudgetUsd\(budgetPerAgent, specs\.length, caps\)/.test(src));
  check('the engine defaults to Claude, and one that can\'t launch is off with its reason shown', /useState\(CLAUDE\)/.test(src) && /disabled=\{id !== CLAUDE && why !== null\}/.test(src) && /\{providerLabel\(p\.id\)\}: \{p\.unavailable\}/.test(src));
  check("the model picker follows the engine: Claude's catalog, else the engine's list or any id", /\{claude \? \(\s*<div className="sp-efforts">\s*<span className="ui-lab">model<\/span>\s*<ModelSelect/.test(src) && /useProviderModels\(claude \? null : provider\)/.test(src) && /list="sp-engine-models"/.test(src) && /theirs\.list\?\.note/.test(src));
  check('the budget field is dollars or tokens, by costUsd', /has\.budget === 'usd' \? \(\s*<span className="sp-pill" aria-pressed=\{budgetPerAgent !== null\}>\s*⏱ stop each agent after \$/.test(src) && /value=\{budgetTok\}/.test(src));
  check('effort, helpers and plan mode show only where the engine has them', /\{has\.effort && \(\s*<div className="sp-efforts">\s*<span className="ui-lab">effort/.test(src) && /\{has\.helpers && \(\s*<select/.test(src) && /MODES\.filter\(\(m\) => offersMode\(m\.id, caps\)\)/.test(src));
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
  check('the developer persona is on sonnet; the validator persona tests what was built', dev.model === 'sonnet' && personaFor(BUILT_IN_PERSONAS, 'validator')?.description === 'Tests what was built and reports what fails.');

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

console.log(
  failures === 0
    ? '\nTrack A spawn: PASS — presets resolve, each role takes its own model, launch defaults are read, custom setups hold together, presets and Custom rows take their personas, a reading role cannot write, and a launch on another engine sends its provider, its model and a cap in its own unit while a Claude launch is unchanged.\n'
    : `\nTrack A spawn: FAIL — ${failures} check(s) failed.\n`,
);process.exit(failures === 0 ? 0 : 1);
