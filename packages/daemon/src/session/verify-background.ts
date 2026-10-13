/**
 * Validator checks for Amendment 133: an agent's turn ending ends its process, so nothing it
 * starts is left to die in the background.
 *
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/session/verify-background.ts
 *
 * The rules are pure (`background.ts`) and checked as such; then a real ClaudeRunner is launched
 * against a fake SDK, and the PreToolUse hook it hands the SDK is called the way Claude Code
 * calls it, so what the agent would actually get back is what is checked. That the SDK applies an
 * `updatedInput` from a hook with no permission decision was checked against the real SDK on
 * 12 Oct: a background Agent call ran in the foreground and its answer came back as the result.
 */

import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookCallback, HookJSONOutput, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { modelSources } from './models.js';
import { sdk } from './runner.js';
import { DEFAULT_AUTONOMY, getAgent, insertAgent, insertJob } from './store.js';
import { supervisor } from './supervisor.js';
import { FOREGROUND_NOTE, TURN_END_LINE, declinedHere, foregroundInput, withTurnEndLine } from './background.js';

modelSources.gateway = () => Promise.reject(new Error('verify asked the real model API'));
modelSources.claudeCode = () => Promise.reject(new Error('verify started a real Claude Code'));

const PORT = 7814;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(realpathSync(tmpdir()), `conductor-background-verify-${Date.now()}`);

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, detail = ''): void {
  checks++;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function send<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await settle(20);
  }
  return true;
}

// ── a fake SDK that keeps the options it was given, hooks included ─────────

interface FakeRun {
  options: Options;
  finish(): void;
}
const runs: FakeRun[] = [];

function fakeQuery({ prompt, options }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  let wake: (() => void) | null = null;
  let done = false;
  const run: FakeRun = {
    options: options ?? {},
    finish() {
      done = true;
      wake?.();
    },
  };
  runs.push(run);
  const sessionId = `sess_bg_${runs.length}`;
  void (async () => {
    if (typeof prompt !== 'string') for await (const _ of prompt) void _;
  })();
  async function* messages(): AsyncGenerator<unknown> {
    yield { type: 'system', subtype: 'init', session_id: sessionId };
    if (!done) await new Promise<void>((r) => (wake = r));
    yield { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, session_id: sessionId };
  }
  return Object.assign(messages(), { interrupt: async () => run.finish(), setModel: async () => undefined }) as unknown as Query;
}

/** Call the run's PreToolUse hook the way Claude Code does. */
async function preToolUse(run: FakeRun, tool: string, input: Record<string, unknown>, id: string): Promise<HookJSONOutput> {
  const hook = run.options.hooks?.PreToolUse?.[0]?.hooks[0] as HookCallback | undefined;
  if (!hook) throw new Error('the run has no PreToolUse hook');
  return hook(
    { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: ROOT } as never,
    id,
    { signal: new AbortController().signal },
  );
}

const out = (o: HookJSONOutput): Record<string, unknown> =>
  ((o as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {});

async function main(): Promise<void> {
  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · the rules');
  const bg = foregroundInput('Agent', { description: 'd', prompt: 'p', subagent_type: 'general-purpose', run_in_background: true });
  check('a background Agent call runs in the foreground instead, with the rest of its input kept', bg?.input['run_in_background'] === false && bg.input['prompt'] === 'p' && bg.input['subagent_type'] === 'general-purpose');
  check('and the model is told why', bg?.note === FOREGROUND_NOTE && /killed when your turn ends/.test(FOREGROUND_NOTE));
  check('under its older name, Task, too', foregroundInput('Task', { run_in_background: true })?.input['run_in_background'] === false);
  check('a foreground Agent call is left as it is', foregroundInput('Agent', { prompt: 'p' }) === null && foregroundInput('Agent', { run_in_background: false }) === null);
  check('a background shell command is left as it is: a dev server for this turn is meant to stop with it', foregroundInput('Bash', { command: 'npm run dev', run_in_background: true }) === null);
  check('a workflow is declined, saying what to do instead', /Agent calls in the foreground/.test(declinedHere('Workflow') ?? ''));
  check('nothing else is declined', declinedHere('Agent') === null && declinedHere('Bash') === null && declinedHere('Edit') === null);
  check('and not to end its turn to wait on something outside', /never end it to wait/.test(TURN_END_LINE) && /gh run watch/.test(TURN_END_LINE) && /foreground first/.test(TURN_END_LINE));
  check('every agent is told, after its persona', withTurnEndLine('Be terse.') === `Be terse.\n\n${TURN_END_LINE}` && withTurnEndLine(null) === TURN_END_LINE && withTurnEndLine('  ') === TURN_END_LINE);
  check('the line says what dies and what to do', /process ends/.test(TURN_END_LINE) && /background subagents, workflows, background shell commands/.test(TURN_END_LINE) && /foreground/.test(TURN_END_LINE));

  // ───────────────────────────────────────────────────────────────────────────
  process.env['CONDUCTOR_DB'] = join(ROOT, 'conductor.db');
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, 'README.md'), '# background verify\n');

  sdk.query = fakeQuery as typeof sdk.query;
  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();

  const added = await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'background-verify' });
  const projectId = added.body.project.id;
  insertJob(db, { id: 'job_bg', projectId, prompt: 'build it', isolation: 'in_place', worktreePath: ROOT, branch: '(no git)', status: 'working', budgetUsd: null });
  insertAgent(db, {
    id: 'agt_bg', jobId: 'job_bg', projectId, role: 'architect', model: 'claude-sonnet-5', sdkSessionId: null, status: 'queued',
    blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: DEFAULT_AUTONOMY,
  });
  supervisor().pump();

  console.log('\n2 · a real runner, through the hook it gives the SDK');
  check('the agent launches', await until(() => runs.length === 1), String(runs.length));
  const run = runs[0]!;
  const sp = run.options.systemPrompt as { type?: string; append?: string } | undefined;
  check('its system prompt carries the turn-end line, appended to Claude Code\'s own', sp?.type === 'preset' && sp.append === TURN_END_LINE, JSON.stringify(sp));

  const a = out(await preToolUse(run, 'Agent', { description: 'd', prompt: 'build lane C', subagent_type: 'general-purpose', run_in_background: true }, 'tu_1'));
  const ai = a['updatedInput'] as Record<string, unknown> | undefined;
  check('a background Agent call comes back to run in the foreground', ai?.['run_in_background'] === false && ai['prompt'] === 'build lane C', JSON.stringify(a));
  check('with the note for the model', a['additionalContext'] === FOREGROUND_NOTE);
  check('and no permission decision: whether it may run is still the guardrails\' to say', !('permissionDecision' in a), String(a['permissionDecision']));

  const w = out(await preToolUse(run, 'Workflow', { script: 'export const meta = {}' }, 'tu_2'));
  check('a workflow is denied, with the reason', w['permissionDecision'] === 'deny' && /runs in the background/.test(String(w['permissionDecisionReason'])), JSON.stringify(w));

  const b = await preToolUse(run, 'Bash', { command: 'npm run dev', run_in_background: true }, 'tu_3');
  check('a background shell command is only observed, as before', (b as { async?: boolean }).async === true && !('hookSpecificOutput' in b), JSON.stringify(b));
  const f = await preToolUse(run, 'Agent', { description: 'd', prompt: 'p', subagent_type: 'general-purpose' }, 'tu_4');
  check('a foreground Agent call is only observed, as before', (f as { async?: boolean }).async === true, JSON.stringify(f));

  run.finish();
  await until(() => getAgent(db, 'agt_bg')?.status !== 'working');

  await app.close();
  rmSync(ROOT, { recursive: true, force: true });
  console.log(
    failures === 0
      ? `\nAmendment 133 background: PASS — ${checks} checks: every agent is told its turn ending ends its process; a background Agent call runs in the foreground, with a note and no decision; a workflow is declined with what to do instead; a background shell command is left alone.`
      : `\nAmendment 133 background: FAIL — ${failures} of ${checks} checks failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify crashed', err);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
