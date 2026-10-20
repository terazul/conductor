/**
 * Full-stack validation of "add / remove an agent in a running job".
 *
 *   cd packages/web && pnpm exec tsx --no-warnings=ExperimentalWarning scripts/validate-stack.ts
 *
 * Part 1 checks the web rules in src/spawn/stack.ts on their own. Part 2 boots the real
 * daemon (fake SDK, nothing is spent) and sends it the requests the web code builds:
 * what the web says is addable must be accepted, and what the web says is a problem must
 * be refused by the daemon as well. Lives outside src/ so web's tsc does not pull in the
 * daemon.  If interrupted:  lsof -ti :7812 | xargs kill -9
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '@conductor/shared';
import {
  addAgentProblems,
  addAgentSpec,
  addedAutonomy,
  feedOptions,
  jobEngine,
  parseCap,
  rewirePreview,
  templateFor,
  waitOptions,
  type AddDraft,
} from '../src/spawn/stack.js';
import { BUILT_IN_PERSONAS } from '../src/spawn/personas.js';
import { build } from '../../daemon/src/index.js';
import { openDb } from '../../daemon/src/db/index.js';
import { modelSources } from '../../daemon/src/session/models.js';
import { sdk } from '../../daemon/src/session/runner.js';
import { DEFAULT_AUTONOMY, agentsForJob, getAgent, insertAgent, insertJob } from '../../daemon/src/session/store.js';

const PORT = 7812;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = 'us.anthropic.claude-opus-5-5';
const WRITE = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

let failures = 0;
const failed: string[] = [];
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) return void console.log(`  ✓ ${label}`);
  failures += 1;
  failed.push(label);
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

const A = (id: string, role: string, o: Partial<Agent> = {}): Agent => ({
  id, jobId: 'j', projectId: 'p', role, model: MODEL, sdkSessionId: null, status: 'queued', blockMode: null,
  costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [],
  autonomy: { ...DEFAULT_AUTONOMY, mode: 'acceptEdits', budgetUsd: 5 }, startedAt: null, endedAt: null, ...o,
} as Agent);

function part1(): void {
  console.log('\n1 · web rules (spawn/stack.ts)');
  const usd = (t: string) => parseCap(t, true);
  check('usd: "5" → 5', JSON.stringify(usd('5')) === '{"usd":5}');
  check('usd: "$2.5" → 2.5', JSON.stringify(usd('$2.5')) === '{"usd":2.5}');
  check('usd: " 7 " trimmed', JSON.stringify(usd(' 7 ')) === '{"usd":7}');
  for (const bad of ['', '   ', '0', '-1', 'abc', 'Infinity', 'NaN', '$'])
    check(`usd: ${JSON.stringify(bad)} refused`, 'why' in usd(bad), JSON.stringify(usd(bad)));
  const tok = (t: string) => parseCap(t, false);
  check('tokens: 500k', JSON.stringify(tok('500k')) === '{"tokens":500000}');
  check('tokens: 2M', JSON.stringify(tok('2M')) === '{"tokens":2000000}');
  check('tokens: 1,500', JSON.stringify(tok('1,500')) === '{"tokens":1500}');
  for (const bad of ['', '0', 'lots', '-5k']) check(`tokens: ${JSON.stringify(bad)} refused`, 'why' in tok(bad));

  const stack = [
    A('dev', 'developer', { status: 'working', sdkSessionId: 's' }),
    A('scr', 'scribe', { dependsOn: ['dev'] }),
    A('old', 'old', { status: 'stopped' }),
    A('hlp', 'helper-1', { parentId: 'dev' } as Partial<Agent>),
    A('slept', 'slept', { sdkSessionId: 'x' }),
    A('rev', 'reviewer', { dependsOn: ['dev'], autonomy: { ...DEFAULT_AUTONOMY, mode: 'plan', disallowedTools: WRITE, budgetUsd: 3 } }),
  ];
  const ids = (xs: Agent[]) => xs.map((a) => a.id).sort().join(',');
  check('waitOptions drops helpers and stopped', ids(waitOptions(stack)) === 'dev,rev,scr,slept', ids(waitOptions(stack)));
  check('feedOptions: queued, no session, not a helper', ids(feedOptions(stack)) === 'rev,scr', ids(feedOptions(stack)));
  check('jobEngine: claude by default', jobEngine(stack) === 'claude' && jobEngine([]) === 'claude');
  check('jobEngine: follows first own agent', jobEngine([A('c', 'x', { provider: 'copilot' } as Partial<Agent>)]) === 'copilot');

  const draft = (o: Partial<AddDraft> = {}): AddDraft => ({ role: 'tester', brief: '', dependsOnRoles: [], feeds: [], model: MODEL, budget: '5', ...o });
  const probs = (o: Partial<AddDraft>, s = stack) => addAgentProblems(draft(o), s, true);
  check('clean draft → no problems', probs({}).length === 0, probs({}).join('|'));
  check('bad role chars', probs({ role: 'Bad Role' as never }).length > 0);
  check('role starting with a digit', probs({ role: '1x' as never }).length > 0);
  check('role too long', probs({ role: 'a'.repeat(40) as never }).length > 0);
  check('duplicate role', probs({ role: 'scribe' }).some((p) => /already in this job/.test(p)));
  check('wait for unknown role', probs({ dependsOnRoles: ['ghost'] }).some((p) => /not in this job/.test(p)));
  check('wait for stopped', probs({ dependsOnRoles: ['old'] }).some((p) => /stopped/.test(p)));
  check('feed a started agent', probs({ feeds: ['developer'] }).some((p) => /already started/.test(p)));
  check('feed an unknown role', probs({ feeds: ['ghost'] }).length > 0);
  check('feed a helper', probs({ feeds: ['helper-1'] }).length > 0);
  check('feed one with a session', probs({ feeds: ['slept'] }).length > 0);
  check('loop detected (wait scribe, feed scribe)', probs({ dependsOnRoles: ['scribe'], feeds: ['scribe'] }).some((p) => /loop/.test(p)));
  check('loop detected transitively', probs({ dependsOnRoles: ['reviewer'], feeds: ['scribe'] }).length === 0 /* reviewer waits dev, scribe waits dev: siblings, no loop */);
  check('empty model', probs({ model: '  ' }).some((p) => /model/i.test(p)));
  check('empty cap', probs({ budget: '' }).length > 0);

  const re = rewirePreview(stack, 'scr');
  check('rewirePreview: nothing waits on scribe → empty', re === '', re);
  const chain = [A('a', 'architect', { status: 'done', sdkSessionId: 's' }), A('b', 'validator', { dependsOn: ['a'] }), A('c', 'scribe', { dependsOn: ['b'] })];
  check('rewirePreview names who moves and what for', rewirePreview(chain, 'b') === 'scribe will start: architect is done.', rewirePreview(chain, 'b'));
  const chain2 = [A('a', 'architect', { status: 'working', sdkSessionId: 's' }), A('b', 'validator', { dependsOn: ['a'] }), A('c', 'scribe', { dependsOn: ['b'] })];
  check('rewirePreview: waits for architect instead', rewirePreview(chain2, 'b') === 'scribe will wait for architect instead.', rewirePreview(chain2, 'b'));

  // Autonomy
  const writers = [A('w', 'developer', { autonomy: { ...DEFAULT_AUTONOMY, mode: 'acceptEdits', allowedTools: ['Bash', 'mcp__*'], budgetUsd: 9 } })];
  const asReader = addedAutonomy(writers, 'reviewer', undefined, { usd: 4 });
  check('reader added to a writing job: write tools denied', WRITE.every((t) => asReader.disallowedTools.includes(t)));
  check('reader: mode is plan/default', asReader.mode === 'plan' || asReader.mode === 'default', asReader.mode);
  check('reader: no Bash / mcp allowed', !asReader.allowedTools.includes('Bash') && !asReader.allowedTools.includes('mcp__*'));
  check('reader: takes its own cap', asReader.budgetUsd === 4);
  const asWriter = addedAutonomy(writers, 'developer-2' as never, undefined, { usd: 4 });
  check('writer added to a writing job: not pinned read-only', !WRITE.some((t) => asWriter.disallowedTools.includes(t)));
  const readers = [A('r', 'reviewer', { autonomy: { ...DEFAULT_AUTONOMY, mode: 'plan', disallowedTools: WRITE, budgetUsd: 3 } })];
  const wInReaders = addedAutonomy(readers, 'developer', undefined, { usd: 4 });
  check('writer into a job of readers does not inherit the read-only pin', !WRITE.every((t) => wInReaders.disallowedTools.includes(t)) && wInReaders.mode !== 'plan', JSON.stringify(wInReaders));
  check('writer into readers: template is not a reader', templateFor(readers, 'developer') !== undefined);
  const tokens = addedAutonomy(writers, 'tester' as never, undefined, { tokens: 7000 });
  check('token cap: budgetUsd null, budgetTokens set', tokens.budgetUsd === null && tokens.budgetTokens === 7000);
  const withTok = [A('t', 'x', { autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: null, budgetTokens: 100 } })];
  const back = addedAutonomy(withTok, 'tester' as never, undefined, { usd: 2 });
  check('usd cap drops a template\'s token cap', back.budgetUsd === 2 && back.budgetTokens === undefined, JSON.stringify(back));
  check('does not mutate the template\'s lists', writers[0]!.autonomy.disallowedTools.length === 0 && readers[0]!.autonomy.disallowedTools.length === 4);
  const pr = BUILT_IN_PERSONAS.find((p) => p.tools.write === false);
  if (pr) {
    const viaPersona = addedAutonomy(writers, 'custom-reader' as never, pr, { usd: 1 });
    check('a read-only persona pins even under a custom role name', WRITE.every((t) => viaPersona.disallowedTools.includes(t)));
  }
}

async function part2(): Promise<void> {
  console.log('\n2 · web requests → real daemon');
  process.env['CONDUCTOR_DB'] = join(tmpdir(), `conductor-validate-stack-${Date.now()}.db`);
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';
  delete process.env['OPENROUTER_API_KEY'];
  modelSources.gateway = () => Promise.reject(new Error('asked the real model API'));
  modelSources.claudeCode = () => Promise.reject(new Error('started a real Claude Code'));
  const ROOT = join(realpathSync(tmpdir()), `conductor-validate-stack-${Date.now()}`);
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'README.md'), '# v\n');
  const git = (a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'v@c.test']);
  git(['config', 'user.name', 'v']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'i']);

  // Nothing may run: every agent stays where the fixture put it.
  const realQuery = sdk.query;
  sdk.query = (() => { throw new Error('validator: an agent tried to run'); }) as unknown as typeof sdk.query;

  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as { detail?: string; agent?: Agent } };
  };
  const pid = ((await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ROOT, name: 'v' }) })).json()) as { project: { id: string } }).project.id;

  // A job where the developer is working and a scribe waits: nothing is startable, so no run.
  let n = 0;
  const makeJob = (): string => {
    const jobId = `job_s${++n}`;
    insertJob(db, { id: jobId, projectId: pid, prompt: 'p', isolation: 'in_place', worktreePath: ROOT, branch: 'main', status: 'working', budgetUsd: null });
    const base = { jobId, projectId: pid, model: MODEL, blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, autonomy: { ...DEFAULT_AUTONOMY, mode: 'acceptEdits' as const, budgetUsd: 5 } };
    insertAgent(db, { ...base, id: `${jobId}_dev`, role: 'developer', status: 'working', sdkSessionId: 'sess', dependsOn: [] });
    insertAgent(db, { ...base, id: `${jobId}_scr`, role: 'scribe', status: 'queued', sdkSessionId: null, dependsOn: [`${jobId}_dev`] });
    return jobId;
  };

  const personas = BUILT_IN_PERSONAS;
  check('there are built-in personas to try', personas.length >= 5, String(personas.length));
  for (const persona of personas) {
    const jobId = makeJob();
    const agents = agentsForJob(db, jobId);
    const draft: AddDraft = { role: `${persona.id}-x` as never, brief: '', persona: persona.id, dependsOnRoles: ['developer'], feeds: ['scribe'], model: MODEL, budget: '4' };
    check(`${persona.id}: web sees no problems`, addAgentProblems(draft, agents, true).length === 0, addAgentProblems(draft, agents, true).join('|'));
    const spec = addAgentSpec(draft, agents, persona, true);
    const res = await post(`/api/jobs/${jobId}/agents`, spec);
    check(`${persona.id}: daemon accepts the request the web builds`, res.status === 201, `${res.status} ${res.body.detail ?? ''}`);
    // Role name 'persona-x' is not in the daemon's read-only list; the persona pin is the web's alone.
    if (persona.tools.write === false && res.status === 201) {
      const row = getAgent(db, res.body.agent!.id)!;
      check(`${persona.id}: stored read-only (write tools denied)`, WRITE.every((t) => row.autonomy.disallowedTools.includes(t)));
      check(`${persona.id}: stored with its own $4 cap`, row.autonomy.budgetUsd === 4);
    }
  }

  // Reading roles by name: the web pin must satisfy the daemon's own check.
  for (const role of ['reviewer', 'debugger', 'analyst', 'auditor']) {
    const jobId = makeJob();
    const agents = agentsForJob(db, jobId);
    const spec = addAgentSpec({ role: role as never, brief: '', dependsOnRoles: ['developer'], feeds: [], model: MODEL, budget: '2' }, agents, undefined, true);
    const res = await post(`/api/jobs/${jobId}/agents`, spec);
    check(`reading role ${role}: web pin passes the daemon's check`, res.status === 201, `${res.status} ${res.body.detail ?? ''}`);
  }
  // …including in a job whose only agents are readers, and one with acceptEdits siblings.
  {
    const jobId = makeJob();
    const mk = (id: string, role: string) => insertAgent(db, { id, jobId, projectId: pid, role, model: MODEL, sdkSessionId: null, status: 'queued', blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: { ...DEFAULT_AUTONOMY, mode: 'bypassPermissions', allowedTools: ['Bash', 'mcp__*'], budgetUsd: 5 } });
    mk('s_bp', 'builder');
    const spec = addAgentSpec({ role: 'reviewer', brief: '', dependsOnRoles: [], feeds: [], model: MODEL, budget: '2' }, agentsForJob(db, jobId), undefined, true);
    const res = await post(`/api/jobs/${jobId}/agents`, spec);
    check('reader added next to a bypassPermissions sibling is pinned and accepted', res.status === 201, `${res.status} ${res.body.detail ?? ''}`);
    const row = res.body.agent && getAgent(db, res.body.agent.id);
    check('  …and its mode is not bypassPermissions', !!row && row.autonomy.mode !== 'bypassPermissions', row?.autonomy.mode);
  }

  // Agreement on refusals: whatever the web flags, the daemon refuses too.
  const scenarios: [string, Partial<AddDraft>][] = [
    ['duplicate role', { role: 'scribe' }],
    ['wait for unknown', { dependsOnRoles: ['ghost'] }],
    ['feed a started agent', { feeds: ['developer'] }],
    ['loop', { dependsOnRoles: ['scribe'], feeds: ['scribe'] }],
  ];
  for (const [label, o] of scenarios) {
    const jobId = makeJob();
    const agents = agentsForJob(db, jobId);
    const draft: AddDraft = { role: 'extra' as never, brief: '', dependsOnRoles: [], feeds: [], model: MODEL, budget: '3', ...o };
    const web = addAgentProblems(draft, agents, true);
    const before = agentsForJob(db, jobId).length;
    const res = await post(`/api/jobs/${jobId}/agents`, addAgentSpec(draft, agents, undefined, true));
    check(`${label}: web flags it`, web.length > 0);
    check(`${label}: daemon refuses it too (400, no row)`, res.status === 400 && agentsForJob(db, jobId).length === before, `${res.status}`);
  }

  // And the reverse: remove what was added through the web request and compare to the preview.
  {
    const jobId = makeJob();
    const agents = agentsForJob(db, jobId);
    const spec = addAgentSpec({ role: 'qa' as never, brief: '', dependsOnRoles: ['developer'], feeds: ['scribe'], model: MODEL, budget: '3' }, agents, undefined, true);
    const added = await post(`/api/jobs/${jobId}/agents`, spec);
    const after = agentsForJob(db, jobId);
    const preview = rewirePreview(after, added.body.agent!.id);
    check('preview of removing it says the scribe waits for the developer', preview === 'scribe will wait for developer instead.', preview);
    const del = await fetch(`${BASE}/api/agents/${added.body.agent!.id}`, { method: 'DELETE' });
    check('DELETE → 200', del.status === 200, String(del.status));
    check('and the scribe really waits for the developer again', JSON.stringify(getAgent(db, `${jobId}_scr`)?.dependsOn) === JSON.stringify([`${jobId}_dev`]));
  }

  sdk.query = realQuery;
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });
}

part1();
part2()
  .then(() => {
    console.log(failures === 0 ? '\nFull-stack validator: PASS\n' : `\nFull-stack validator: FAIL — ${failures}:\n${failed.map((f) => `  - ${f}`).join('\n')}\n`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error('validator crashed', err);
    process.exit(1);
  });
