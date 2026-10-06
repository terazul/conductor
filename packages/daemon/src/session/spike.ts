/**
 * PHASE 0 SPIKE — not production code, and nothing imports it.
 *
 * It was written to be thrown away once Track A landed. It is kept instead as
 * runnable evidence (README "Verify"): the arbiter's design rests on the three
 * behaviours below, and `arbiter/index.ts` cites its measurements. Re-run it after
 * an SDK upgrade, before trusting the arbiter against the new version. It spends
 * real tokens, which is why `make test` does not run it.
 *
 * Proves (or disproves) the three SDK behaviours the plan is built on, against
 * the real @anthropic-ai/claude-agent-sdk v0.3.278 and a real scratch repo.
 *
 *   1  indefinite hold    canUseTool stays pending >60s, then the tool runs
 *   2  park and resume     PreToolUse -> 'defer', SIGKILL the process, restart
 *                          with options.resume, deferred call proceeds
 *   3  full observation    async PreToolUse sees EVERY call under acceptEdits,
 *                          including ones canUseTool never sees
 *
 * Also measures: events/sec from one busy agent, wall-clock cost of a resume.
 *
 * Run:  pnpm --filter @conductor/daemon spike
 *       tsx src/session/spike.ts <hold|park|resume|observe|all>
 *
 * Subcommands run as separate child processes so that "kill the process
 * entirely" means exactly that — SIGKILL, no graceful shutdown, no shared heap.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, type Options, type PermissionResult, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SCRATCH = join(REPO_ROOT, 'fixtures/scratch-repo');

/**
 * Isolate the CLI's config dir. Two reasons:
 *  - the host machine's own allow-rules must not silently auto-approve the very
 *    prompt test 1 depends on (that would make a pass meaningless);
 *  - it is a FIXED path, not a temp-per-process one, so the session transcript
 *    written by the parked process is still on disk for the resumed process.
 */
const CONFIG_DIR = '/tmp/conductor-spike-config';
const PARK_FILE = '/tmp/conductor-spike-park.json';

process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
mkdirSync(CONFIG_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
function log(...a: unknown[]): void {
  console.log(`[${stamp()}]`, ...a);
}

/** Streaming input mode: an AsyncIterable we can push to and close. */
class InputStream implements AsyncIterable<SDKUserMessage> {
  #queue: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(text: string): void {
    this.#queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage);
    this.#wake?.();
    this.#wake = null;
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
    this.#wake = null;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.#queue.length > 0) yield this.#queue.shift()!;
      if (this.#closed) return;
      await new Promise<void>((r) => {
        this.#wake = r;
      });
    }
  }
}

/** Shared base options. Sonnet, not the env default (Opus-1M), to keep the spike cheap. */
function baseOptions(): Options {
  return {
    cwd: SCRATCH,
    env: { ...process.env, CLAUDE_CONFIG_DIR: CONFIG_DIR },
    model: process.env.SPIKE_MODEL ?? 'sonnet',
    // Keep the blast radius small and the runs cheap.
    maxTurns: 12,
  };
}

/** One-line description of any SDK message, for the transcript dump. */
function describe(m: SDKMessage): string {
  if (m.type === 'assistant') {
    const blocks = (m.message.content as unknown as Array<Record<string, unknown>>) ?? [];
    const parts = blocks.map((b) =>
      b.type === 'text'
        ? `text(${String(b.text).slice(0, 60).replace(/\n/g, ' ')})`
        : b.type === 'tool_use'
          ? `tool_use(${String(b.name)})`
          : String(b.type),
    );
    return `assistant ${parts.join(' ')}`;
  }
  if (m.type === 'result') {
    const r = m as Record<string, unknown>;
    return `result subtype=${String(r.subtype)} terminal_reason=${String(r.terminal_reason)} deferred=${JSON.stringify(r.deferred_tool_use ?? null)} cost=${String(r.total_cost_usd)}`;
  }
  if (m.type === 'system') return `system ${String((m as Record<string, unknown>).subtype)}`;
  if (m.type === 'user') return 'user (tool_result)';
  return m.type;
}

interface Verdict {
  name: string;
  pass: boolean;
  detail: string;
}
const verdicts: Verdict[] = [];
function verdict(name: string, pass: boolean, detail: string): void {
  verdicts.push({ name, pass, detail });
  console.log(`\n${pass ? '  PASS' : '  FAIL'} — ${name}\n         ${detail}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1 — indefinite hold
// ─────────────────────────────────────────────────────────────────────────────

const HOLD_SECONDS = Number(process.env.SPIKE_HOLD_SECONDS ?? 65);

async function testHold(): Promise<void> {
  log(`TEST 1 — indefinite hold (${HOLD_SECONDS}s)`);

  const input = new InputStream();
  let firedAt = 0;
  let resolvedAt = 0;
  let releaser: ((r: PermissionResult) => void) | null = null;
  let sawToolResult = false;
  let resultText = '';

  // Proof-of-execution: the tool must actually write this file, and it must not
  // exist before the held promise is released.
  const proof = join(SCRATCH, 'hold-probe.txt');
  rmSync(proof, { force: true });
  let existedBeforeRelease = true;

  const q = query({
    prompt: input,
    options: {
      ...baseOptions(),
      permissionMode: 'default',
      // Write under 'default' always needs a human. (Bash `echo` does NOT — the
      // CLI auto-approves trivially-safe commands, so it never reaches
      // canUseTool. That is finding A showing up even in 'default' mode.)
      canUseTool: async (toolName, toolInput) => {
        firedAt = Date.now();
        existedBeforeRelease = existsSync(proof);
        log(`  canUseTool fired: ${toolName} ${JSON.stringify(toolInput).slice(0, 120)}`);
        log(`  holding the promise for ${HOLD_SECONDS}s WITHOUT returning...`);
        return new Promise<PermissionResult>((res) => {
          releaser = res;
          // Release from OUTSIDE this callback, HOLD_SECONDS after it fired —
          // the stand-in for a human answering over a socket. The timer is the
          // only thing that can unblock the agent.
          setTimeout(() => {
            resolvedAt = Date.now();
            log(
              `  releasing now, ${((resolvedAt - firedAt) / 1000).toFixed(1)}s after it fired`,
            );
            res({ behavior: 'allow', updatedInput: undefined });
          }, HOLD_SECONDS * 1000);
        });
      },
    },
  });

  // Release is scheduled from inside canUseTool, timed from when it actually
  // fired (the tool call can arrive several seconds into the turn).
  const timer: NodeJS.Timeout | null = null;

  input.push(
    'Use the Write tool to create a file named hold-probe.txt in the current ' +
      'directory containing exactly this one line: CONDUCTOR_HOLD_OK. ' +
      'Then stop. Do not run any bash commands.',
  );

  for await (const m of q) {
    log('  <-', describe(m));
    if (m.type === 'user') sawToolResult = true;
    if (m.type === 'result') {
      resultText = String((m as Record<string, unknown>).result ?? '');
      break;
    }
  }
  clearTimeout(timer ?? undefined);
  input.close();

  const heldFor = firedAt && resolvedAt ? (resolvedAt - firedAt) / 1000 : 0;
  const wroteFile = existsSync(proof);

  verdict(
    'TEST 1 · canUseTool holds indefinitely, then the tool runs',
    firedAt > 0 && heldFor >= HOLD_SECONDS - 2 && wroteFile && !existedBeforeRelease,
    `fired=${firedAt > 0} held=${heldFor.toFixed(1)}s ` +
      `fileExistedBeforeRelease=${existedBeforeRelease} fileWritten=${wroteFile} ` +
      `sawToolResult=${sawToolResult} result="${resultText.slice(0, 60)}"`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2 — park (phase A) then resume across process death (phase B)
// ─────────────────────────────────────────────────────────────────────────────

async function testPark(): Promise<void> {
  log('TEST 2a — park via PreToolUse defer');

  // The deferred write must NOT have happened by the time we are killed.
  rmSync(join(SCRATCH, 'park-probe.txt'), { force: true });

  const input = new InputStream();
  let sessionId = '';
  let deferred: unknown = null;
  let terminalReason = '';
  let hookFired = 0;

  const q = query({
    prompt: input,
    options: {
      ...baseOptions(),
      permissionMode: 'default',
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput) => {
                if (hookInput.hook_event_name !== 'PreToolUse') return { continue: true };
                hookFired += 1;
                log(`  PreToolUse -> DEFER for ${hookInput.tool_name} (${hookInput.tool_use_id})`);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'defer',
                    permissionDecisionReason: 'parked by conductor spike',
                  },
                };
              },
            ],
          },
        ],
      },
    },
  });

  input.push(
    'Use the Write tool to create a file named park-probe.txt in the current ' +
      'directory containing exactly this one line: CONDUCTOR_PARK_OK. ' +
      'Then stop. Do not run any bash commands.',
  );

  for await (const m of q) {
    log('  <-', describe(m));
    if (m.type === 'system' && (m as Record<string, unknown>).subtype === 'init') {
      sessionId = String((m as Record<string, unknown>).session_id ?? '');
      log(`  session_id = ${sessionId}`);
    }
    if (m.type === 'result') {
      const r = m as Record<string, unknown>;
      sessionId = sessionId || String(r.session_id ?? '');
      deferred = r.deferred_tool_use ?? null;
      terminalReason = String(r.terminal_reason ?? '');
      break;
    }
  }
  input.close();

  writeFileSync(
    PARK_FILE,
    JSON.stringify({ sessionId, deferred, terminalReason, parkedAt: Date.now() }, null, 2),
  );

  log(
    `  PARKED sessionId=${sessionId} terminal_reason=${terminalReason} deferred=${JSON.stringify(deferred)}`,
  );
  log(`  wrote ${PARK_FILE}`);
  console.log(`SPIKE_PARK_READY ${sessionId}`);

  verdict(
    'TEST 2a · PreToolUse defer ends the query and names the deferred call',
    hookFired > 0 && sessionId !== '' && terminalReason === 'tool_deferred' && deferred !== null,
    `hookFired=${hookFired} terminal_reason=${terminalReason} deferred=${JSON.stringify(deferred)}`,
  );

  // Stay alive so the orchestrator can SIGKILL us — a real kill, not an exit.
  if (process.env.SPIKE_WAIT_FOR_KILL === '1') {
    log('  idling for SIGKILL...');
    await new Promise(() => {});
  }
}

async function testResume(): Promise<void> {
  log('TEST 2b — resume after the process was killed');

  if (!existsSync(PARK_FILE)) {
    verdict('TEST 2b · resume', false, `no ${PARK_FILE} — phase A did not park`);
    return;
  }
  const parked = JSON.parse(readFileSync(PARK_FILE, 'utf8')) as {
    sessionId: string;
    deferred: { id: string; name: string; input: Record<string, unknown> } | null;
  };
  log(`  resuming ${parked.sessionId}, deferred=${JSON.stringify(parked.deferred)}`);

  const proof = join(SCRATCH, 'park-probe.txt');
  const existedBefore = existsSync(proof);
  log(`  park-probe.txt exists before resume: ${existedBefore} (must be false)`);

  const input = new InputStream();
  let allowedTool = 0;
  let sawToolResult = false;
  let resultText = '';
  let firstMessageAt = 0;
  let toolProceededAt = 0;

  const startedAt = Date.now();

  const q = query({
    prompt: input,
    options: {
      ...baseOptions(),
      permissionMode: 'default',
      resume: parked.sessionId,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput) => {
                if (hookInput.hook_event_name !== 'PreToolUse') return { continue: true };
                allowedTool += 1;
                toolProceededAt = Date.now();
                log(
                  `  PreToolUse -> ALLOW for ${hookInput.tool_name} ` +
                    `(decision made while the process was DEAD)`,
                );
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    permissionDecisionReason: 'human approved while daemon was down',
                  },
                };
              },
            ],
          },
        ],
      },
    },
  });

  // Does the deferred call retry on its own, or does it need a nudge? Find out.
  let nudged = false;
  const nudgeTimer = setTimeout(() => {
    if (allowedTool === 0) {
      nudged = true;
      log('  no retry after 20s — nudging with a continuation message');
      input.push('Continue with the command you were about to run.');
    }
  }, 20_000);

  for await (const m of q) {
    if (!firstMessageAt) firstMessageAt = Date.now();
    log('  <-', describe(m));
    if (m.type === 'user') sawToolResult = true;
    if (m.type === 'result') {
      resultText = String((m as Record<string, unknown>).result ?? '');
      break;
    }
  }
  clearTimeout(nudgeTimer);
  input.close();

  const wroteFile = existsSync(proof);

  verdict(
    'TEST 2b · deferred call proceeds after SIGKILL + options.resume',
    allowedTool > 0 && wroteFile && !existedBefore,
    `hookRefired=${allowedTool} fileExistedBefore=${existedBefore} fileWritten=${wroteFile} ` +
      `sawToolResult=${sawToolResult} neededNudge=${nudged} result="${resultText.slice(0, 60)}"`,
  );

  // ── measurement (b): wall-clock cost of a resume ──────────────────────────
  const toInit = firstMessageAt ? firstMessageAt - startedAt : -1;
  const toTool = toolProceededAt ? toolProceededAt - startedAt : -1;
  console.log(
    `\nMEASURE resume_wall_clock_ms first_message=${toInit} deferred_call_reached=${toTool} nudged=${nudged}\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3 — full-fidelity observation + event-volume measurement
// ─────────────────────────────────────────────────────────────────────────────

async function testObserve(): Promise<void> {
  log('TEST 3 — async PreToolUse sees every call under acceptEdits');

  const input = new InputStream();
  let hookSaw = 0;
  let canUseToolSaw = 0;
  const hookTools: string[] = [];
  const canUseToolTools: string[] = [];
  let messages = 0;
  const startedAt = Date.now();

  const q = query({
    prompt: input,
    options: {
      ...baseOptions(),
      permissionMode: 'acceptEdits',
      // Loose on purpose: this is the mode people actually run agents in, and
      // the one where canUseTool goes quiet (finding A).
      allowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'TodoWrite'],
      maxTurns: 20,
      // SPIKE_PARTIAL=1 bounds the worst case for the browser: token-level
      // deltas instead of whole messages. Production leaves this off.
      includePartialMessages: process.env.SPIKE_PARTIAL === '1',
      toolConfig: { askUserQuestion: { previewFormat: 'html' } },
      canUseTool: async (toolName) => {
        canUseToolSaw += 1;
        canUseToolTools.push(toolName);
        log(`  canUseTool saw ${toolName}`);
        return { behavior: 'allow', updatedInput: undefined };
      },
      hooks: {
        PreToolUse: [
          {
            // no matcher — every tool
            hooks: [
              async (hookInput) => {
                if (hookInput.hook_event_name !== 'PreToolUse') return { continue: true };
                hookSaw += 1;
                hookTools.push(hookInput.tool_name);
                // Never block the agent on our bookkeeping (CONTRACT.md §5.4).
                return { async: true, asyncTimeout: 30_000 };
              },
            ],
          },
        ],
      },
    },
  });

  input.push(
    'Do all of these in order, using one tool call each, then stop:\n' +
      '1. read docs/PLAN.md\n' +
      '2. read src/token.js\n' +
      '3. list files with glob **/*.js\n' +
      '4. grep for the word rotate\n' +
      '5. write a new file notes/spike-observed.md containing the single line: observed\n' +
      '6. append a second line to that same file saying: twice\n' +
      '7. run bash: echo CONDUCTOR_OBSERVE_OK',
  );

  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let partials = 0;

  for await (const m of q) {
    messages += 1;
    if (m.type === 'stream_event') partials += 1;
    else log('  <-', describe(m));
    if (m.type === 'result') {
      const r = m as Record<string, unknown>;
      costUsd = Number(r.total_cost_usd ?? 0);
      const u = (r.usage ?? {}) as Record<string, number>;
      inputTokens = Number(u.input_tokens ?? 0);
      outputTokens = Number(u.output_tokens ?? 0);
      break;
    }
  }
  input.close();

  const wallSec = (Date.now() - startedAt) / 1000;

  verdict(
    'TEST 3 · async PreToolUse observes calls canUseTool never sees',
    hookSaw > 0 && hookSaw > canUseToolSaw,
    `hook=${hookSaw} [${hookTools.join(', ')}] canUseTool=${canUseToolSaw} ` +
      `[${canUseToolTools.join(', ') || 'none'}]`,
  );

  // ── measurement (a): event volume from one busy agent ─────────────────────
  console.log(
    `\nMEASURE event_volume partial=${process.env.SPIKE_PARTIAL === '1'} ` +
      `wall_s=${wallSec.toFixed(1)} sdk_messages=${messages} partials=${partials} ` +
      `tool_starts=${hookSaw} msgs_per_sec=${(messages / wallSec).toFixed(2)} ` +
      `tool_starts_per_sec=${(hookSaw / wallSec).toFixed(2)} ` +
      `cost_usd=${costUsd} in_tok=${inputTokens} out_tok=${outputTokens}\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4 — held -> parked escalation. canUseTool cannot return `defer`, so the
// only way to convert an aged hold into a park is to end the turn. Does
// interrupt() + resume re-offer the same tool call?
// This decides the Arbiter's state machine, so it is worth proving.
// ─────────────────────────────────────────────────────────────────────────────

async function testEscalate(): Promise<void> {
  log('TEST 4 — held -> parked via interrupt(), then resume');

  const proof = join(SCRATCH, 'escalate-probe.txt');
  rmSync(proof, { force: true });

  const input = new InputStream();
  let sessionId = '';
  let aborted = false;
  let interruptedAt = 0;

  const q = query({
    prompt: input,
    options: {
      ...baseOptions(),
      permissionMode: 'default',
      canUseTool: async (toolName, _i, { signal }) => {
        log(`  canUseTool fired for ${toolName} — holding, will interrupt in 8s`);
        signal.addEventListener('abort', () => {
          aborted = true;
          log('  canUseTool signal ABORTED (interrupt reached the callback)');
        });
        setTimeout(() => {
          interruptedAt = Date.now();
          log('  calling q.interrupt() while the promise is still pending');
          void q.interrupt().catch((e) => log(`  interrupt threw: ${String(e).slice(0, 80)}`));
        }, 8000);
        // Never resolve: simulate a human who has not answered.
        return new Promise<PermissionResult>(() => {});
      },
    },
  });

  input.push(
    'Use the Write tool to create a file named escalate-probe.txt in the current ' +
      'directory containing exactly this one line: CONDUCTOR_ESCALATE_OK. Then stop.',
  );

  let endedReason = '';
  try {
    for await (const m of q) {
      log('  <-', describe(m));
      if (m.type === 'system' && (m as Record<string, unknown>).subtype === 'init') {
        sessionId = String((m as Record<string, unknown>).session_id ?? '');
      }
      if (m.type === 'result') {
        const r = m as Record<string, unknown>;
        sessionId = sessionId || String(r.session_id ?? '');
        endedReason = `${String(r.subtype)}/${String(r.terminal_reason)}`;
        break;
      }
    }
  } catch (err) {
    endedReason = `threw: ${String(err).slice(0, 120)}`;
    log(`  iteration threw: ${endedReason}`);
  }
  input.close();

  const queryEnded = endedReason !== '';
  log(`  query ended: ${endedReason} · sessionId=${sessionId} · wroteFile=${existsSync(proof)}`);

  verdict(
    'TEST 4a · interrupt() ends a query whose canUseTool is still pending',
    queryEnded && !existsSync(proof),
    `aborted=${aborted} ended=${endedReason} interruptLatencyMs=${interruptedAt ? Date.now() - interruptedAt : -1} ` +
      `fileWritten=${existsSync(proof)} (must be false)`,
  );

  if (!sessionId) {
    verdict('TEST 4b · resume after interrupt re-offers the tool', false, 'no sessionId captured');
    return;
  }

  // Now resume in a fresh query and allow it — the "answered while parked" path.
  log('  resuming the interrupted session with an ALLOW decision');
  const input2 = new InputStream();
  let reoffered = 0;
  const startedAt = Date.now();

  const q2 = query({
    prompt: input2,
    options: {
      ...baseOptions(),
      permissionMode: 'default',
      resume: sessionId,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput) => {
                if (hookInput.hook_event_name !== 'PreToolUse') return { continue: true };
                reoffered += 1;
                log(`  PreToolUse re-offered ${hookInput.tool_name} -> ALLOW`);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'allow',
                    permissionDecisionReason: 'human answered after escalation',
                  },
                };
              },
            ],
          },
        ],
      },
    },
  });

  // If the tool is not re-offered on its own, a nudge tells us the difference
  // between "needs a prompt" and "lost entirely".
  let nudged = false;
  const nudge = setTimeout(() => {
    if (reoffered === 0) {
      nudged = true;
      log('  no re-offer after 20s — nudging');
      input2.push('Continue with the write you were about to do.');
    }
  }, 20_000);

  for await (const m of q2) {
    log('  <-', describe(m));
    if (m.type === 'result') break;
  }
  clearTimeout(nudge);
  input2.close();

  verdict(
    'TEST 4b · resume after interrupt re-offers the tool and it runs',
    reoffered > 0 && existsSync(proof),
    `reoffered=${reoffered} fileWritten=${existsSync(proof)} neededNudge=${nudged} ` +
      `resumeMs=${Date.now() - startedAt}`,
  );
}



function runChild(
  args: string[],
  env: Record<string, string> = {},
  onLine?: (line: string, kill: () => void) => void,
): Promise<number> {
  return new Promise((res) => {
    // tsx, not bare node: these are .ts files and the parent already runs under tsx.
    const tsx = join(REPO_ROOT, 'node_modules/.bin/tsx');
    const child = spawn(tsx, args, {
      cwd: join(REPO_ROOT, 'packages/daemon'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const kill = () => {
      log(`  >>> SIGKILL pid ${child.pid} <<<`);
      child.kill('SIGKILL');
    };
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        console.log(line);
        onLine?.(line, kill);
      }
    });
    child.on('exit', (code, signal) => {
      log(`  child exited code=${code} signal=${signal}`);
      res(code ?? -1);
    });
  });
}

async function runAll(): Promise<void> {
  const self = fileURLToPath(import.meta.url);
  rmSync(PARK_FILE, { force: true });

  console.log('\n══════ TEST 1 · indefinite hold ══════');
  await runChild([self, 'hold']);

  console.log('\n══════ TEST 2a · park, then SIGKILL ══════');
  await runChild([self, 'park'], { SPIKE_WAIT_FOR_KILL: '1' }, (line, kill) => {
    if (line.includes('SPIKE_PARK_READY')) {
      // Give the CLI a moment to flush the transcript, then kill it dead.
      setTimeout(kill, 2000);
    }
  });

  console.log('\n══════ TEST 2b · resume in a NEW process ══════');
  await runChild([self, 'resume']);

  console.log('\n══════ TEST 3 · full-fidelity observation ══════');
  await runChild([self, 'observe']);

  console.log('\n══════ spike complete ══════');
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'all';
  if (!existsSync(SCRATCH)) {
    console.error(`scratch repo missing — run: bash fixtures/make-scratch-repo.sh`);
    process.exit(1);
  }
  log(`spike ${cmd} · cwd=${SCRATCH} · config=${CONFIG_DIR}`);

  switch (cmd) {
    case 'hold':
      await testHold();
      break;
    case 'park':
      await testPark();
      break;
    case 'resume':
      await testResume();
      break;
    case 'observe':
      await testObserve();
      break;
    case 'escalate':
      await testEscalate();
      break;
    case 'all':
      await runAll();
      return;
    default:
      console.error(`unknown subcommand ${cmd}`);
      process.exit(1);
  }

  const failed = verdicts.filter((v) => !v.pass).length;
  console.log(
    failed === 0
      ? `\nspike ${cmd}: all ${verdicts.length} check(s) passed\n`
      : `\nspike ${cmd}: ${failed} of ${verdicts.length} check(s) FAILED\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

void main();
