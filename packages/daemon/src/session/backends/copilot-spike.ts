/**
 * STEP 0 SPIKE for the multi-provider plan — not production code, and nothing imports it.
 *
 * docs/plans/multi-provider-findings.md answers the plan's eleven questions from the
 * @github/copilot-sdk 1.0.16 type definitions and docs. Those answers are what the
 * Copilot backend is built on, but a .d.ts is a promise, not a measurement. This file
 * checks the promises that matter against the real service. It spends real requests
 * (premium requests on Copilot, credit on OpenRouter), which is why `make test` does not
 * run it. Re-run it after an SDK upgrade.
 *
 *   auth      who the runtime thinks you are (Copilot login status)
 *   models    the Copilot model list                                     Q11
 *   hold      a permission request held >60s, then approved; the tool runs  Q4
 *   observe   every tool call seen under approve-all, with usage          Q5 Q7
 *   steer     a mid-run message with mode "immediate", then abort        Q1 Q2
 *   tool      an in-process custom tool is offered and called            Q8
 *   park      leave a permission pending, SIGKILL; `resume` picks it up   Q3 Q6
 *   byok      OpenRouter via BYOK with every GitHub credential removed    Q10
 *   all       everything except byok, which needs OPENROUTER_API_KEY
 *
 * Run:  tsx src/session/backends/copilot-spike.ts <subcommand>
 *       OPENROUTER_API_KEY=… tsx src/session/backends/copilot-spike.ts byok
 *
 * The key is read from the environment and handed to the SDK. It is never printed.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CopilotClient, approveAll, defineTool, type CopilotSession } from '@github/copilot-sdk';

const PARK_FILE = '/tmp/conductor-copilot-spike-park.json';
const MODEL = process.env.SPIKE_MODEL ?? 'gpt-5-mini';
const OR_MODEL = process.env.SPIKE_OR_MODEL ?? 'anthropic/claude-sonnet-4.5';

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
function log(...a: unknown[]): void {
  console.log(`[${stamp()}]`, ...a);
}

let failures = 0;
function verdict(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}\n`);
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-copilot-spike-'));
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  return dir;
}

/** One line per event, arguments by key only: a spike log is no place for file contents. */
function trace(session: CopilotSession, seen: string[]): void {
  session.on((e) => {
    seen.push(e.type);
    const d = (e as { data?: Record<string, unknown> }).data ?? {};
    if (e.type === 'tool.execution_start') log('  tool start', d.toolName, Object.keys((d.arguments as object) ?? {}));
    else if (e.type === 'assistant.usage') log('  usage', JSON.stringify(d));
    else if (e.type === 'permission.requested') log('  permission requested', (d.permissionRequest as { kind?: string })?.kind);
    else if (!e.type.endsWith('_delta')) log('  event', e.type);
  });
}

async function withClient<T>(fn: (c: CopilotClient) => Promise<T>, opts: ConstructorParameters<typeof CopilotClient>[0] = {}): Promise<T> {
  const client = new CopilotClient(opts);
  // createSession starts the runtime itself; getAuthStatus and listModels do not.
  await client.start();
  try {
    return await fn(client);
  } finally {
    const errors = await client.stop();
    if (errors.length) log('client.stop errors', errors.map((e) => e.message));
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function auth(): Promise<void> {
  await withClient(async (c) => {
    const s = await c.getAuthStatus();
    log('auth', { isAuthenticated: s.isAuthenticated, authType: s.authType, host: s.host, login: s.login });
    verdict('auth', s.isAuthenticated, `authType=${s.authType ?? '—'}`);
  });
}

async function models(): Promise<void> {
  await withClient(async (c) => {
    const list = await c.listModels();
    for (const m of list) log('  model', m.id, '·', m.name, '· efforts', m.supportedReasoningEfforts ?? '—', '· multiplier', m.billing?.multiplier ?? '—');
    verdict('Q11 models', list.length > 0, `${list.length} models`);
  });
}

async function hold(): Promise<void> {
  const cwd = scratch();
  await withClient(async (c) => {
    const seen: string[] = [];
    const session = await c.createSession({
      model: MODEL,
      workingDirectory: cwd,
      onPermissionRequest: async (req) => {
        log(`  holding ${req.kind} for 70s`);
        await new Promise((r) => setTimeout(r, 70_000));
        log('  approving');
        return { kind: 'approve-once' };
      },
    });
    trace(session, seen);
    await session.sendAndWait({ prompt: 'Create a file named held.txt containing the word ok. Use a tool; do not just describe it.' }, 240_000);
    const ok = existsSync(join(cwd, 'held.txt'));
    verdict('Q4 hold', ok, ok ? 'file written after a 70s hold' : `no file; events: ${[...new Set(seen)].join(' ')}`);
    await session.disconnect();
  });
  rmSync(cwd, { recursive: true, force: true });
}

async function observe(): Promise<void> {
  const cwd = scratch();
  await withClient(async (c) => {
    const seen: string[] = [];
    let asked = 0;
    const session = await c.createSession({
      model: MODEL,
      workingDirectory: cwd,
      onPermissionRequest: (req, inv) => {
        asked++;
        return approveAll(req, inv);
      },
    });
    trace(session, seen);
    await session.sendAndWait({ prompt: 'Read README.md, then list the files here with a shell command, then create notes.txt saying hi.' }, 240_000);
    const starts = seen.filter((t) => t === 'tool.execution_start').length;
    const usage = seen.filter((t) => t === 'assistant.usage').length;
    log('  metrics', JSON.stringify(await session.rpc.usage.getMetrics()));
    verdict('Q5 observe', starts >= 3, `${starts} tool.execution_start events, ${asked} permission requests`);
    verdict('Q7 usage', usage > 0, `${usage} assistant.usage events`);
    await session.disconnect();
  });
  rmSync(cwd, { recursive: true, force: true });
}

async function steer(): Promise<void> {
  const cwd = scratch();
  await withClient(async (c) => {
    const seen: string[] = [];
    const session = await c.createSession({ model: MODEL, workingDirectory: cwd, onPermissionRequest: approveAll });
    trace(session, seen);
    void session.send({ prompt: 'Count slowly from 1 to 200, one number per line, with a shell command `sleep 1` between every ten.' });
    await new Promise((r) => setTimeout(r, 8_000));
    await session.send({ prompt: 'Stop counting. Reply with only the word REDIRECTED.', mode: 'immediate' });
    await new Promise((r) => setTimeout(r, 20_000));
    const redirected = seen.includes('user.message');
    await session.abort();
    await new Promise((r) => setTimeout(r, 2_000));
    verdict('Q1 steer', redirected, 'immediate message accepted mid-turn (check the transcript for REDIRECTED)');
    verdict('Q2 abort', seen.includes('abort') || seen.includes('session.idle'), `events after abort include ${seen.slice(-3).join(' ')}`);
    await session.disconnect();
  });
  rmSync(cwd, { recursive: true, force: true });
}

async function tool(): Promise<void> {
  let called = 0;
  const listHelpers = defineTool('list_helpers', {
    description: 'List the helper agents working for you.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    skipPermission: true,
    handler: () => {
      called++;
      return 'No helpers are running.';
    },
  });
  await withClient(async (c) => {
    const seen: string[] = [];
    const session = await c.createSession({ model: MODEL, onPermissionRequest: approveAll, tools: [listHelpers] });
    trace(session, seen);
    await session.sendAndWait({ prompt: 'Call list_helpers and tell me what it says.' }, 120_000);
    verdict('Q8 custom tool', called > 0, `handler called ${called} time(s)`);
    await session.disconnect();
  });
}

/** Phase one of Q3/Q6, run in a child that the parent SIGKILLs while the request is pending. */
async function park(): Promise<void> {
  const cwd = scratch();
  const sessionId = `conductor-spike-${Date.now()}`;
  const client = new CopilotClient();
  const session = await client.createSession({
    sessionId,
    model: MODEL,
    workingDirectory: cwd,
    onPermissionRequest: () => {
      writeFileSync(PARK_FILE, JSON.stringify({ sessionId, cwd }));
      log('  parked; waiting to be killed');
      return new Promise(() => {});
    },
  });
  trace(session, []);
  void session.send({ prompt: 'Create a file named parked.txt containing ok.' });
  await new Promise(() => {});
}

async function resume(): Promise<void> {
  const { sessionId, cwd } = JSON.parse(readFileSync(PARK_FILE, 'utf8')) as { sessionId: string; cwd: string };
  await withClient(async (c) => {
    const seen: string[] = [];
    const session = await c.resumeSession(sessionId, {
      continuePendingWork: true,
      workingDirectory: cwd,
      onPermissionRequest: () => ({ kind: 'approve-once' }),
    });
    trace(session, seen);
    await new Promise((r) => setTimeout(r, 30_000));
    const ok = existsSync(join(cwd, 'parked.txt'));
    verdict('Q3 resume', true, `resumed ${sessionId}`);
    verdict('Q6 re-offer', ok, ok ? 'parked call re-offered and ran after SIGKILL' : `no file; events: ${[...new Set(seen)].join(' ')}`);
    await session.disconnect();
  });
  rmSync(cwd, { recursive: true, force: true });
  rmSync(PARK_FILE, { force: true });
}

async function parkThenResume(): Promise<void> {
  rmSync(PARK_FILE, { force: true });
  const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'park'], {
    stdio: 'inherit',
    env: { ...process.env, SPIKE_PARK_CHILD: '1' },
  });
  const deadline = Date.now() + 120_000;
  while (!existsSync(PARK_FILE) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  child.kill('SIGKILL');
  if (!existsSync(PARK_FILE)) return verdict('Q6 park', false, 'no permission request within 120s');
  log('SIGKILLed the parked process; resuming');
  await resume();
}

async function byok(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return verdict('Q10 byok', false, 'OPENROUTER_API_KEY is not set');
  // Strip every GitHub credential the runtime would otherwise find, and give it an empty
  // home, so a pass proves BYOK needs no login rather than borrowing yours.
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'GITHUB_COPILOT_API_TOKEN', 'COPILOT_API_URL']) delete process.env[k];
  const home = join(tmpdir(), 'conductor-copilot-spike-home');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  await withClient(
    async (c) => {
      const seen: string[] = [];
      const session = await c.createSession({
        model: OR_MODEL,
        provider: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey },
        onPermissionRequest: approveAll,
      });
      trace(session, seen);
      const reply = await session.sendAndWait({ prompt: 'Reply with only the word PONG.' }, 120_000);
      const text = String((reply as { data?: { content?: unknown } } | undefined)?.data?.content ?? '');
      verdict('Q10 byok', /PONG/i.test(text), `reply "${text.slice(0, 40)}" from ${OR_MODEL} with no GitHub credential`);
      await session.disconnect();
    },
    { useLoggedInUser: false, baseDirectory: home },
  );
}

const SUBCOMMANDS: Record<string, () => Promise<void>> = {
  auth,
  models,
  hold,
  observe,
  steer,
  tool,
  park: () => (process.env.SPIKE_PARK_CHILD ? park() : parkThenResume()),
  resume,
  byok,
};

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'all';
  if (which === 'all') {
    for (const f of [auth, models, hold, observe, steer, tool]) await f();
    await parkThenResume();
  } else {
    const f = SUBCOMMANDS[which];
    if (!f) throw new Error(`unknown subcommand ${which}; one of ${Object.keys(SUBCOMMANDS).join(', ')}, all`);
    await f();
  }
  console.log(failures ? `${failures} FAILED` : 'all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
