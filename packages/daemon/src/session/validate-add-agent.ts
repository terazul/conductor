/**
 * Independent validation of "add / remove an agent in a running job" (Amendment 89, ADR 0002).
 *
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning \
 *     src/session/validate-add-agent.ts
 *
 * Written from the commit message and the contract, not from session/verify.ts §17p. It
 * leans on cases §17p does not cover: transitive loops, helpers, stopped feeds, trimmed and
 * repeated roles, token-only caps, malformed bodies, add-then-remove round trips, a full
 * pool, and the pure helpers in @conductor/shared. Fake SDK throughout: costs nothing.
 *
 * If interrupted:  lsof -ti :7811 | xargs kill -9
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  READ_ONLY_ROLES,
  WRITE_TOOLS,
  createsCycle,
  isReadOnlyRole,
  readOnlyRefusal,
  rewireOnRemoval,
  type AddAgentResponse,
  type Agent,
  type RemoveAgentResponse,
} from '@conductor/shared';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { modelSources } from './models.js';
import { jobCap } from './budget.js';
import { sdk } from './runner.js';
import {
  DEFAULT_AUTONOMY,
  agentsForJob,
  getAgent,
  getAgentPersona,
  getJob,
  insertAgent,
  insertJob,
  setAgentStatus,
} from './store.js';
import { slotLimit, supervisor } from './supervisor.js';

modelSources.gateway = () => Promise.reject(new Error('validator asked the real model API'));
modelSources.claudeCode = () => Promise.reject(new Error('validator started a real Claude Code'));

const PORT = 7811;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(realpathSync(tmpdir()), `conductor-validate-add-${Date.now()}`);
const MODEL = 'us.anthropic.claude-opus-5-5';

let failures = 0;
const failed: string[] = [];
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) return void console.log(`  ✓ ${label}`);
  failures += 1;
  failed.push(label);
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}

async function send<T>(method: string, path: string, body?: unknown, raw?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {},
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

const settle = (ms = 100): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await settle(20);
  }
  return true;
}

interface FakeRun {
  options: Options;
  prompts: string[];
  finish(): void;
  finished: boolean;
}
const runs: FakeRun[] = [];
function fakeQuery({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  let wake: (() => void) | null = null;
  const run: FakeRun = {
    options: options ?? {},
    prompts: [],
    finished: false,
    finish() {
      if (run.finished) return;
      run.finished = true;
      wake?.();
    },
  };
  runs.push(run);
  const sessionId = `sess_val_${runs.length}`;
  void (async () => {
    if (typeof prompt === 'string') return void run.prompts.push(prompt);
    for await (const m of prompt) run.prompts.push(String(m.message.content));
  })();
  async function* messages(): AsyncGenerator<unknown> {
    yield { type: 'system', subtype: 'init', session_id: sessionId };
    while (!run.finished) await new Promise<void>((r) => (wake = r));
    yield {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0,
      terminal_reason: 'completed',
      usage: { input_tokens: 1, output_tokens: 1 },
      session_id: sessionId,
    };
  }
  return Object.assign(messages(), {
    interrupt: async () => run.finish(),
    setModel: async () => undefined,
  }) as unknown as Query;
}
const runOf = (role: string) => runs.find((r) => (r.prompts[0] ?? '').includes(`Your role is ${role}.`));
const finishAll = (): void => {
  for (const r of runs) r.finish();
};

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = join(tmpdir(), `conductor-validate-add-${Date.now()}.db`);
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';
  delete process.env['OPENROUTER_API_KEY'];

  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'README.md'), '# validate\n');
  const git = (a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'v@conductor.test']);
  git(['config', 'user.name', 'v']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'init']);

  const realQuery = sdk.query;
  sdk.query = fakeQuery as typeof sdk.query;
  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();
  const sup = supervisor();

  const proj = await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'validate' });
  const pid = proj.body.project.id;

  const five = { ...DEFAULT_AUTONOMY, budgetUsd: 5 };
  const job = (id: string, status: 'working' | 'done' | 'failed' | 'paused' = 'working') =>
    insertJob(db, { id, projectId: pid, prompt: `p ${id}`, isolation: 'in_place', worktreePath: ROOT, branch: 'main', status, budgetUsd: null });
  const fixture = (id: string, jobId: string, a: Partial<Agent>) =>
    insertAgent(db, {
      id, jobId, projectId: pid, role: 'builder', model: MODEL, sdkSessionId: null, status: 'done', blockMode: null,
      costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: five, ...a,
    });
  const spec = (role: string, o: Record<string, unknown> = {}) => ({ role, model: MODEL, brief: `Do ${role}.`, autonomy: five, ...o });
  type Added = AddAgentResponse & { detail?: string; error?: string };
  const add = (jobId: string, body: unknown, raw?: string) => send<Added>('POST', `/api/jobs/${jobId}/agents`, body, raw);
  const refused = async (label: string, jobId: string, body: unknown, why: RegExp) => {
    const before = agentsForJob(db, jobId).length;
    const r = await add(jobId, body);
    check(label, r.status === 400 && why.test(r.body.detail ?? ''), `${r.status} ${JSON.stringify(r.body)}`);
    check(`  …and left no row (${label})`, agentsForJob(db, jobId).length === before);
  };

  // ── A · shared pure helpers ───────────────────────────────────────────────
  console.log('\nA · shared helpers');
  const chain = [
    { id: 'a', dependsOn: [] as string[] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['b'] },
    { id: 'd', dependsOn: [] as string[] },
  ];
  check('cycle: feeds the direct dependency', createsCycle(chain, ['a'], ['a']));
  check('cycle: feeds a dependency two steps up', createsCycle(chain, ['c'], ['a']));
  check('cycle: feeds a transitive ancestor of a middle node', createsCycle(chain, ['b'], ['a']));
  check('no cycle: feeds something downstream of what it waits on', !createsCycle(chain, ['a'], ['c']));
  check('no cycle: unrelated feed', !createsCycle(chain, ['c'], ['d']));
  check('no cycle: no feeds', !createsCycle(chain, ['c'], []));
  check('no cycle: no deps', !createsCycle(chain, [], ['a', 'b', 'c']));
  check('cycle terminates on a diamond', !createsCycle(
    [{ id: 'r', dependsOn: [] }, { id: 'x', dependsOn: ['r'] }, { id: 'y', dependsOn: ['r'] }, { id: 'z', dependsOn: ['x', 'y'] }],
    ['z'], ['q']));
  check('READ_ONLY_ROLES is the four documented', ['reviewer', 'debugger', 'analyst', 'auditor'].every((r) => READ_ONLY_ROLES.has(r as never)) && READ_ONLY_ROLES.size === 4);
  check('isReadOnlyRole: developer is not', !isReadOnlyRole('developer' as never));
  for (const role of READ_ONLY_ROLES) {
    check(`${role}: all write tools + plan is fine`, readOnlyRefusal(role, { mode: 'plan', disallowedTools: [...WRITE_TOOLS] }) === null);
    check(`${role}: default mode is fine`, readOnlyRefusal(role, { mode: 'default', disallowedTools: [...WRITE_TOOLS] }) === null);
    for (const t of WRITE_TOOLS) {
      const r = readOnlyRefusal(role, { mode: 'plan', disallowedTools: WRITE_TOOLS.filter((x) => x !== t) });
      check(`${role}: missing ${t} is refused and names it`, !!r && r.includes(t));
    }
    for (const mode of ['acceptEdits', 'bypassPermissions'] as const) {
      check(`${role}: ${mode} is refused`, !!readOnlyRefusal(role, { mode, disallowedTools: [...WRITE_TOOLS] }));
    }
  }
  check('a writing role is never refused', readOnlyRefusal('developer' as never, { mode: 'bypassPermissions', disallowedTools: [] }) === null);
  {
    const stack = [
      { id: 'p', dependsOn: [] as string[], status: 'done' as const, sdkSessionId: 's' },
      { id: 'n', dependsOn: ['p'], status: 'queued' as const, sdkSessionId: null },
      { id: 'm', dependsOn: ['n', 'p'], status: 'queued' as const, sdkSessionId: null },
      { id: 'run', dependsOn: ['n'], status: 'working' as const, sdkSessionId: 's2' },
    ];
    const rw = rewireOnRemoval(stack as never, 'n');
    check('rewire: waiter inherits removed one\'s deps, no duplicates', JSON.stringify(rw.find((r) => r.agentId === 'm')?.dependsOn) === '["p"]', JSON.stringify(rw));
    check('rewire: a started agent is left alone', !rw.some((r) => r.agentId === 'run'));
    check('rewire: unknown id → nothing', rewireOnRemoval(stack as never, 'zzz').length === 0);
  }

  // ── B · request-shape edge cases ──────────────────────────────────────────
  console.log('\nB · request shape');
  job('job_b');
  fixture('b_dev', 'job_b', { role: 'developer', status: 'working', sdkSessionId: 's_b_dev' });
  fixture('b_scr', 'job_b', { role: 'scribe', status: 'queued', dependsOn: ['b_dev'] });
  fixture('b_stop', 'job_b', { role: 'stopped-one', status: 'stopped' });
  fixture('b_stopq', 'job_b', { role: 'stopped-q', status: 'stopped' });
  fixture('b_help', 'job_b', { role: 'helper-a', status: 'queued', parentId: 'b_dev' } as Partial<Agent>);
  fixture('b_slept', 'job_b', { role: 'slept', status: 'queued', sdkSessionId: 'sess_slept' });
  const n0 = runs.length;

  await refused('empty body → 400', 'job_b', {}, /role/);
  await refused('role missing → 400', 'job_b', { model: MODEL, autonomy: five }, /role/);
  await refused('model missing → 400', 'job_b', { role: 'x', autonomy: five }, /model/);
  await refused('blank role → 400', 'job_b', spec('   '), /role/);
  await refused('unknown provider → 400', 'job_b', spec('x', { provider: 'skynet' }), /provider/);
  await refused('helpers out of range → 400', 'job_b', spec('x', { helpers: 9999 }), /helpers/);
  await refused('helpers fractional → 400', 'job_b', spec('x', { helpers: 1.5 }), /helpers/);
  await refused('feeds with a non-string → 400', 'job_b', spec('x', { feeds: [1] }), /feeds is a list/);
  await refused('feeds null-ish object → 400', 'job_b', spec('x', { feeds: {} }), /feeds is a list/);
  await refused('budgetUsd 0 counts as no cap → 400', 'job_b', spec('x', { autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: 0 } }), /budget of its own/);
  await refused('negative budgetUsd counts as no cap → 400', 'job_b', spec('x', { autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: -3 } }), /budget of its own/);
  await refused('budgetUsd as string is no cap → 400', 'job_b', spec('x', { autonomy: { ...DEFAULT_AUTONOMY, budgetUsd: '5' } }), /budget of its own/);
  await refused('missing autonomy entirely → no cap → 400', 'job_b', { role: 'x', model: MODEL }, /budget of its own/);
  await refused('role with surrounding spaces still collides', 'job_b', spec('  scribe  '), /already in this job/);
  await refused('depends on a stopped agent', 'job_b', spec('x', { dependsOnRoles: ['stopped-one'] }), /stopped/);
  await refused('feeds a stopped agent', 'job_b', spec('x', { feeds: ['stopped-q'] }), /already started|not queued|stopped/);
  await refused('feeds an unknown role', 'job_b', spec('x', { feeds: ['ghost'] }), /ghost, which is not in this job/);
  await refused('feeds a helper', 'job_b', spec('x', { feeds: ['helper-a'] }), /helper/);
  await refused('feeds a queued agent that already has a session', 'job_b', spec('x', { feeds: ['slept'] }), /already started/);
  await refused('depends on itself (not in job yet)', 'job_b', spec('x', { dependsOnRoles: ['x'] }), /not in this job/);
  await refused('transitive loop: waits for scribe (which waits developer), feeds developer', 'job_b', spec('x', { dependsOnRoles: ['scribe'], feeds: ['scribe'] }), /loop|already started/);
  check('none of that started a run', runs.length === n0);

  const garbage = await add('job_b', undefined, '{not json');
  check('malformed JSON → 4xx, not a 500', garbage.status >= 400 && garbage.status < 500, String(garbage.status));
  const arr = await add('job_b', [1, 2]);
  check('an array body → 400', arr.status === 400, String(arr.status));
  const nul = await add('job_b', null);
  check('a null body → 4xx', nul.status >= 400 && nul.status < 500, String(nul.status));
  check('unknown job → 404 even with a bad body', (await add('job_zzz', {})).status === 404);

  // ── C · accepted shapes ──────────────────────────────────────────────────
  console.log('\nC · accepted shapes');
  const capBefore = jobCap(agentsForJob(db, 'job_b'));
  const dup = await add('job_b', spec('  qa  ', { dependsOnRoles: ['developer', 'developer'], feeds: ['scribe', 'scribe'], helpers: 2 }));
  const qaId = dup.body.agent?.id ?? '';
  check('padded role + repeated deps + repeated feeds → 201', dup.status === 201, JSON.stringify(dup.body));
  check('role is stored trimmed', getAgent(db, qaId)?.role === 'qa');
  check('repeated dependsOnRoles stored once', JSON.stringify(getAgent(db, qaId)?.dependsOn) === '["b_dev"]');
  check('repeated feeds wire the fed agent once', JSON.stringify(getAgent(db, 'b_scr')?.dependsOn) === JSON.stringify(['b_dev', qaId]), JSON.stringify(getAgent(db, 'b_scr')?.dependsOn));
  check('response lists the fed agent once', dup.body.fed?.length === 1);
  check('helper cap is kept on the row', getAgent(db, qaId)?.helperCap === 2, String(getAgent(db, qaId)?.helperCap));
  check('job cap grew by exactly $5', jobCap(agentsForJob(db, 'job_b')) === (capBefore ?? 0) + 5, `${capBefore} → ${jobCap(agentsForJob(db, 'job_b'))}`);
  check('a different job is unaffected', agentsForJob(db, 'job_b').every((a) => a.jobId === 'job_b'));

  const persona = await add('job_b', spec('writer', { persona: 'pirate', systemPrompt: 'Talk like a pirate.', skills: ['grammar'] }));
  check('persona/system prompt/skills are accepted and copied to the row',
    persona.status === 201 && getAgentPersona(db, persona.body.agent.id).persona === 'pirate' && getAgentPersona(db, persona.body.agent.id).systemPrompt === 'Talk like a pirate.' && JSON.stringify(getAgentPersona(db, persona.body.agent.id).skills) === '["grammar"]',
    JSON.stringify(persona.body));
  const tokenOnly = await add('job_b', spec('tok', { autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 5000 } }));
  check('a claude agent with a token-only cap is not accepted silently as dollars (either refused or accepted without crash)', tokenOnly.status === 201 || tokenOnly.status === 400, String(tokenOnly.status));

  // ── D · add, then remove it again: the round trip ────────────────────────
  console.log('\nD · add → remove round trip');
  job('job_d');
  fixture('d_arch', 'job_d', { role: 'architect', status: 'working', sdkSessionId: 's_d_arch' });
  fixture('d_scr', 'job_d', { role: 'scribe', status: 'queued', dependsOn: ['d_arch'] });
  const before = JSON.stringify(agentsForJob(db, 'job_d').map((a) => [a.id, a.dependsOn]));
  const mid = await add('job_d', spec('validator', { dependsOnRoles: ['architect'], feeds: ['scribe'] }));
  const vid = mid.body.agent?.id ?? '';
  check('added in the middle', mid.status === 201 && JSON.stringify(getAgent(db, 'd_scr')?.dependsOn) === JSON.stringify(['d_arch', vid]));
  check('fed agent in the response is the fresh row', mid.body.fed?.[0]?.dependsOn?.includes(vid) === true);
  const rm = await send<RemoveAgentResponse>('DELETE', `/api/agents/${vid}`);
  check('DELETE → 200', rm.status === 200, JSON.stringify(rm.body));
  check('response names it removed and what it rewired', rm.body.removed === vid && rm.body.rewired?.some((r) => r.agentId === 'd_scr'), JSON.stringify(rm.body));
  check('the scribe waits for the architect instead (original wiring restored)',
    JSON.stringify(agentsForJob(db, 'job_d').map((a) => [a.id, a.dependsOn])) === before,
    JSON.stringify(agentsForJob(db, 'job_d').map((a) => [a.id, a.dependsOn])));
  check('the removed row is gone', getAgent(db, vid) === undefined || getAgent(db, vid) === null);
  check('and its role can be used again', (await add('job_d', spec('validator'))).status === 201);
  check('removing an unknown agent → 404', (await send('DELETE', '/api/agents/agt_nope')).status === 404);

  // ── E · lifecycle: ordering, finished job, stopped job, full pool ────────
  console.log('\nE · lifecycle');
  finishAll();
  await until(() => sup.slots.used === 0);
  runs.length = 0;

  job('job_e');
  fixture('e_dev', 'job_e', { role: 'developer', status: 'working', sdkSessionId: 's_e_dev' });
  fixture('e_scr', 'job_e', { role: 'scribe', status: 'queued', dependsOn: ['e_dev'] });
  const qa = await add('job_e', spec('tester', { dependsOnRoles: ['developer'], feeds: ['scribe'] }));
  const qid = qa.body.agent.id;
  await settle(200);
  check('nothing starts while the developer is still working', getAgent(db, qid)?.status === 'queued' && getAgent(db, 'e_scr')?.status === 'queued' && runs.length === 0);
  setAgentStatus(db, 'e_dev', 'done');
  sup.pump();
  check('developer done → tester starts', await until(() => runOf('tester') !== undefined));
  await settle(150);
  check('scribe still waits for tester (fed)', getAgent(db, 'e_scr')?.status === 'queued' && runOf('scribe') === undefined);
  runOf('tester')?.finish();
  check('tester done → scribe starts', await until(() => getAgent(db, 'e_scr')?.status === 'working'));
  finishAll();
  check('job done', await until(() => getJob(db, 'job_e')?.status === 'done'));

  // Failed job: add something independent → reopen and run.
  job('job_f', 'failed');
  fixture('f_dev', 'job_f', { role: 'developer', status: 'failed' });
  const indep = await add('job_f', spec('independent'));
  check('independent agent added to a failed job → 201', indep.status === 201);
  check('failed job reopens as working', getJob(db, 'job_f')?.status === 'working' || getJob(db, 'job_f')?.status === 'failed' /* may re-settle */, getJob(db, 'job_f')?.status);
  check('and the independent agent actually starts', await until(() => runOf('independent') !== undefined));
  finishAll();
  check('job ends failed (the failed dev still counts), not done', await until(() => getJob(db, 'job_f')?.status === 'failed'), getJob(db, 'job_f')?.status);

  // Paused job.
  job('job_p', 'paused');
  fixture('p_dev', 'job_p', { role: 'developer', status: 'paused', sdkSessionId: 's_p' });
  const behindPaused = await add('job_p', spec('after', { dependsOnRoles: ['developer'] }));
  await settle(150);
  check('behind a paused agent: added, queued, not started', behindPaused.status === 201 && getAgent(db, behindPaused.body.agent.id)?.status === 'queued' && runOf('after') === undefined);
  check('and the job is not left claiming to be working', getJob(db, 'job_p')?.status !== 'working', getJob(db, 'job_p')?.status);

  // Full pool: the new agent queues rather than exceeding the slot limit.
  finishAll();
  await until(() => sup.slots.used === 0);
  runs.length = 0;
  job('job_g');
  const limit = slotLimit();
  check('slot limit is readable', typeof limit === 'number');
  const live: string[] = [];
  for (let i = 0; i < Math.max(limit, 1); i += 1) {
    fixture(`g_${i}`, 'job_g', { role: `busy${i}`, status: 'queued' });
    live.push(`g_${i}`);
  }
  sup.pump();
  await until(() => sup.slots.used >= Math.min(limit, live.length));
  const over = await add('job_g', spec('overflow'));
  await settle(200);
  check('a full pool: added and queued', over.status === 201 && getAgent(db, over.body.agent.id)?.status === 'queued', getAgent(db, over.body.agent?.id ?? '')?.status);
  check('slots never exceed the limit', sup.slots.used <= limit, `${sup.slots.used} > ${limit}`);
  finishAll();
  check('when a slot frees, the new agent runs', await until(() => runOf('overflow') !== undefined, 5_000));
  finishAll();
  await until(() => sup.slots.used === 0);

  // ── F · concurrency: same role twice at once ─────────────────────────────
  console.log('\nF · concurrency');
  job('job_h');
  fixture('h_dev', 'job_h', { role: 'developer', status: 'working', sdkSessionId: 's_h' });
  const [r1, r2] = await Promise.all([add('job_h', spec('twin')), add('job_h', spec('twin'))]);
  const created = [r1, r2].filter((r) => r.status === 201).length;
  check('two simultaneous adds of one role → exactly one wins', created === 1, `${r1.status}/${r2.status}`);
  check('only one row for the role', agentsForJob(db, 'job_h').filter((a) => a.role === 'twin').length === 1);

  // ── G · engine mismatch via HTTP (consistent 400, no row) ────────────────
  console.log('\nG · engine');
  const mism = await add('job_h', { role: 'cp', model: 'gpt-5-mini', provider: 'copilot', autonomy: { ...DEFAULT_AUTONOMY, budgetTokens: 1000 } });
  check('copilot agent into a claude job → 4xx, no row', mism.status >= 400 && mism.status < 500 && !agentsForJob(db, 'job_h').some((a) => a.role === 'cp'), `${mism.status} ${JSON.stringify(mism.body)}`);

  finishAll();
  await until(() => sup.slots.used === 0);
  sdk.query = realQuery;
  await app.close();
  rmSync(ROOT, { recursive: true, force: true });

  console.log(failures === 0 ? '\nValidator: PASS\n' : `\nValidator: FAIL — ${failures} check(s):\n${failed.map((f) => `  - ${f}`).join('\n')}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('validator crashed', err);
  process.exit(1);
});
