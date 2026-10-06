#!/usr/bin/env node
/**
 * Fixture generator.
 *
 * W0 OWNS THIS FILE. Tracks may ADD a new generator function and a new output
 * file; never edit another track's fixture.
 *
 *   node fixtures/generate.mjs
 *
 * Output is JSONL — one ServerFrame per line — replayed by
 * packages/web/src/lib/feed.ts when VITE_FIXTURE is set. This is what lets
 * Tracks B and E build the entire UI with no daemon running.
 *
 * Track A: once the spike works, replace these hand-built frames with a real
 * recording by teeing hub().broadcast() to a file. The shapes must stay
 * identical — they're the frozen contract.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const T0 = Date.parse('2026-09-21T14:18:00.000Z');
let seq = 0;
const at = (sec) => new Date(T0 + sec * 1000).toISOString();

const PROJECT = {
  id: 'prj_acme',
  name: 'acme-api',
  path: '/Users/you/src/acme-api',
  defaultBranch: 'main',
  createdAt: at(-3600),
};

const JOB = {
  id: 'job_authrefresh',
  projectId: PROJECT.id,
  prompt:
    "Refresh tokens aren't rotated — a replayed token stays valid. Rotate on every exchange and revoke the ancestor chain. Tests first.",
  isolation: 'worktree',
  worktreePath: '/Users/you/src/acme-api/.conductor/wt/job_authrefresh',
  branch: 'feat/auth-refresh',
  status: 'working',
  createdAt: at(0),
  endedAt: null,
  budgetUsd: 5,
};

const autonomy = {
  mode: 'acceptEdits',
  allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
  disallowedTools: ['Bash(rm -rf /*)', 'Bash(git push *)'],
  budgetUsd: 2.5,
};

const BUILDER = {
  id: 'agt_builder',
  jobId: JOB.id,
  projectId: PROJECT.id,
  role: 'builder',
  model: 'claude-opus-5',
  sdkSessionId: 'sess_9f3a71c2-4d8e-4b1a-9c77-2e5f0a1b6d34',
  status: 'working',
  blockMode: null,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  dependsOn: [],
  startedAt: at(2),
  endedAt: null,
  autonomy,
};

const VALIDATOR = {
  ...BUILDER,
  id: 'agt_validator',
  role: 'validator',
  model: 'claude-sonnet-5',
  sdkSessionId: 'sess_2b8c44de-1f07-4a92-8e3b-77c1d0995aa2',
  startedAt: at(6),
};

const REVIEWER = {
  ...BUILDER,
  id: 'agt_reviewer',
  role: 'reviewer',
  model: 'claude-opus-5',
  sdkSessionId: null,
  status: 'queued',
  dependsOn: [BUILDER.id, VALIDATOR.id],
  startedAt: null,
};

const frames = [];
const push = (f) => frames.push(f);

/** One event frame per call keeps replay pacing legible in the UI. */
function ev(agentId, sec, payload) {
  seq += 1;
  push({
    type: 'events',
    events: [
      {
        seq,
        ts: at(sec),
        projectId: PROJECT.id,
        jobId: JOB.id,
        agentId,
        payload,
      },
    ],
  });
}

// ── opening snapshot ────────────────────────────────────────────────────────
push({
  type: 'hello',
  seq: 0,
  snapshot: {
    projects: [PROJECT],
    jobs: [JOB],
    agents: [BUILDER, VALIDATOR, REVIEWER],
    pending: [],
    servers: [
      {
        jobId: JOB.id,
        port: 3000,
        pid: 48210,
        // Amendment 6: which loopback family actually answered. Vite commonly
        // binds ::1 only, and probing 127.0.0.1 then reports "no server".
        host: '::1',
        proxyPath: `/preview/${JOB.id}/`,
        startedByAgentId: BUILDER.id,
        detectedAt: at(30),
        alive: true,
      },
    ],
    seq: 0,
    slots: { used: 2, total: 7 },
    costToday: 4.18,
  },
});

// ── job scaffolding ─────────────────────────────────────────────────────────
ev(null, 1, {
  kind: 'worktree',
  event: 'created',
  path: JOB.worktreePath,
  branch: JOB.branch,
});

// ── the human's instruction ─────────────────────────────────────────────────
ev(BUILDER.id, 2, { kind: 'user_text', text: JOB.prompt });
ev(BUILDER.id, 3, { kind: 'status', status: 'working' });

// ── builder works ───────────────────────────────────────────────────────────
ev(BUILDER.id, 4, {
  kind: 'text',
  text: 'Reading the current exchange path before changing anything.',
});
ev(BUILDER.id, 5, {
  kind: 'tool_start',
  toolUseId: 'tu_01',
  tool: 'Read',
  input: { file_path: 'src/auth/refresh.ts' },
  label: 'Read src/auth/refresh.ts',
});
ev(BUILDER.id, 6, { kind: 'tool_end', toolUseId: 'tu_01', ok: true, summary: '142 lines', durationMs: 180 });
ev(BUILDER.id, 8, {
  kind: 'text',
  text: 'The exchange marks the old token used but issues the new one with the same family_id and no ancestor link, so reuse detection has nothing to walk. Adding the link first.',
});
ev(BUILDER.id, 10, {
  kind: 'tool_start',
  toolUseId: 'tu_02',
  tool: 'Edit',
  input: { file_path: 'src/auth/token.ts', old_string: 'export function decodeToken(raw: string) {', new_string: 'export function decodeToken(raw: string, opts: DecodeOpts = {}) {' },
  label: 'Edit src/auth/token.ts',
});
ev(BUILDER.id, 11, { kind: 'tool_end', toolUseId: 'tu_02', ok: true, summary: '+18 −4', durationMs: 90 });
ev(BUILDER.id, 11, { kind: 'file_edit', path: 'src/auth/token.ts', added: 18, removed: 4 });
ev(BUILDER.id, 12, {
  kind: 'todo',
  items: [
    { text: 'extract decodeToken', state: 'done' },
    { text: 'clock injection', state: 'done' },
    { text: 'rotation guard', state: 'active' },
    { text: 'family migration', state: 'pending' },
  ],
});
ev(BUILDER.id, 13, {
  kind: 'tool_start',
  toolUseId: 'tu_03',
  tool: 'Bash',
  input: { command: 'npx tsc --noEmit', description: 'typecheck' },
  label: 'Bash npx tsc --noEmit',
});
ev(BUILDER.id, 16, { kind: 'tool_end', toolUseId: 'tu_03', ok: true, summary: 'clean · 2.4s', durationMs: 2400 });
ev(BUILDER.id, 17, { kind: 'usage', costUsd: 0.31, inputTokens: 38_400, outputTokens: 2_100 });

// ── validator starts in parallel ────────────────────────────────────────────
ev(VALIDATOR.id, 7, { kind: 'status', status: 'working' });
ev(VALIDATOR.id, 9, {
  kind: 'tool_start',
  toolUseId: 'tu_10',
  tool: 'Write',
  input: { file_path: 'tests/test_refresh.py' },
  label: 'Write tests/test_refresh.py',
});
ev(VALIDATOR.id, 10, { kind: 'tool_end', toolUseId: 'tu_10', ok: true, summary: 'new file', durationMs: 120 });
ev(VALIDATOR.id, 10, { kind: 'file_edit', path: 'tests/test_refresh.py', added: 64, removed: 0, created: true });
ev(VALIDATOR.id, 14, {
  kind: 'tool_start',
  toolUseId: 'tu_11',
  tool: 'Bash',
  input: { command: 'pytest -k refresh -q' },
  label: 'Bash pytest -k refresh -q',
});
ev(VALIDATOR.id, 19, { kind: 'tool_end', toolUseId: 'tu_11', ok: true, summary: '6 passed, 1 xfail', durationMs: 4800 });
ev(VALIDATOR.id, 20, { kind: 'usage', costUsd: 0.09, inputTokens: 12_900, outputTokens: 880 });

// ── a human is needed ───────────────────────────────────────────────────────
const QUESTION_REQ = {
  requestId: 'req_family',
  projectId: PROJECT.id,
  jobId: JOB.id,
  agentId: BUILDER.id,
  agentRole: 'builder',
  projectName: PROJECT.name,
  kind: 'question',
  blockMode: 'held',
  createdAt: at(21),
  toolName: 'AskUserQuestion',
  input: {},
  questions: [
    {
      question: 'On reuse detection, revoke the whole token family or deny the single request?',
      header: 'Reuse',
      multiSelect: false,
      options: [
        {
          label: 'Hard-revoke the family',
          description: 'Safest. A flaky mobile client can log itself out.',
          // `preview` is populated because we set
          // toolConfig.askUserQuestion.previewFormat = 'html'. We're a browser,
          // so we render Claude's option previews natively — a terminal
          // orchestrator cannot. Track E must render these and must also cope
          // with options that have none (see the multiSelect question below).
          preview:
            '<h4>Replay detected → whole family dies</h4><pre>token_a (used)\n └ token_b  ✗ revoked\n    └ token_c ✗ revoked</pre><p>All sessions in the family are invalidated. User re-authenticates.</p>',
        },
        {
          label: 'Deny the request only',
          description: 'Gentler, but a stolen token stays usable until expiry.',
          preview:
            '<h4>Replay detected → one request refused</h4><pre>token_a (used)  ✗ denied\n └ token_b  ✓ still valid\n    └ token_c ✓ still valid</pre><p>Legitimate client keeps working. So does the attacker.</p>',
        },
      ],
    },
    {
      // Second question: multiSelect, and deliberately WITHOUT previews, so the
      // undefined-preview path is exercised by the fixture too.
      question: 'Which of these should the revocation also cover?',
      header: 'Scope',
      multiSelect: true,
      options: [
        { label: 'Access tokens', description: 'Short-lived; expire on their own within 15 minutes.' },
        { label: 'Device trust records', description: 'Forces re-verification on next sign-in.' },
        { label: 'API keys', description: 'Machine credentials issued under the same subject.' },
      ],
    },
  ],
};

ev(BUILDER.id, 21, {
  kind: 'request',
  requestId: QUESTION_REQ.requestId,
  requestKind: 'question',
  blockMode: 'held',
  label: 'question · family revocation',
});
ev(BUILDER.id, 21, { kind: 'status', status: 'blocked', blockMode: 'held' });
push({ type: 'pending', pending: [QUESTION_REQ] });

// ── the human answers ───────────────────────────────────────────────────────
ev(BUILDER.id, 34, {
  kind: 'resolved',
  requestId: QUESTION_REQ.requestId,
  decision: { type: 'answer', by: 'human' },
});
push({ type: 'pending', pending: [] });
ev(BUILDER.id, 35, { kind: 'status', status: 'working' });
ev(BUILDER.id, 36, {
  kind: 'text',
  text: 'Hard-revoke it is. Writing the guard in refresh.ts, then a regression test that replays a used token and asserts the whole family is dead.',
});
ev(BUILDER.id, 38, {
  kind: 'tool_start',
  toolUseId: 'tu_04',
  tool: 'Edit',
  input: { file_path: 'src/auth/refresh.ts' },
  label: 'Edit src/auth/refresh.ts',
});
ev(BUILDER.id, 39, { kind: 'tool_end', toolUseId: 'tu_04', ok: true, summary: '+24 −6', durationMs: 140 });
ev(BUILDER.id, 39, { kind: 'file_edit', path: 'src/auth/refresh.ts', added: 24, removed: 6 });
ev(BUILDER.id, 41, { kind: 'usage', costUsd: 0.61, inputTokens: 76_200, outputTokens: 4_300 });

// ── a dev server appears, then complains ────────────────────────────────────
ev(null, 44, { kind: 'dev_server', event: 'up', port: 3000, pid: 48210, startedByAgentId: BUILDER.id });
ev(null, 46, { kind: 'console', level: 'error', text: 'GET /api/sessions 500 — token_family_id does not exist' });
ev(null, 46, { kind: 'console', level: 'warn', text: 'Warning: prop `rotatedAt` is undefined in <SessionRow>' });

writeFileSync(
  join(HERE, 'session-basic.jsonl'),
  frames.map((f) => JSON.stringify(f)).join('\n') + '\n',
);
console.log(`session-basic.jsonl — ${frames.length} frames, ${seq} events`);

// ─────────────────────────────────────────────────────────────────────────────
// Track E's fixture: the attention queue, including the aged parked request
// that the mockup's amber rail is built around.
// ─────────────────────────────────────────────────────────────────────────────

const WEBUI = {
  id: 'prj_webui',
  name: 'web-ui',
  path: '/Users/you/src/web-ui',
  defaultBranch: 'main',
  createdAt: at(-7200),
};
const WEBUI_JOB = {
  id: 'job_tokens',
  projectId: WEBUI.id,
  prompt: 'Migrate to the new design tokens.',
  isolation: 'worktree',
  worktreePath: '/Users/you/src/web-ui/.conductor/wt/job_tokens',
  branch: 'feat/design-tokens',
  status: 'blocked',
  createdAt: at(-900),
  endedAt: null,
  budgetUsd: null,
};
const UIUX = {
  id: 'agt_uiux',
  jobId: WEBUI_JOB.id,
  projectId: WEBUI.id,
  role: 'uiux',
  model: 'claude-opus-5',
  sdkSessionId: 'sess_7c1e00aa-33b5-42f9-b0d4-9ac8e2f14477',
  status: 'blocked',
  blockMode: 'parked',
  costUsd: 0.88,
  inputTokens: 51_000,
  outputTokens: 3_900,
  dependsOn: [],
  startedAt: at(-880),
  endedAt: null,
  autonomy,
};

/** Parked: waited past DEFER_AFTER, so the query ended and the session is on disk. */
const PERMISSION_REQ = {
  requestId: 'req_rmrf',
  projectId: WEBUI.id,
  jobId: WEBUI_JOB.id,
  agentId: UIUX.id,
  agentRole: 'uiux',
  projectName: WEBUI.name,
  kind: 'permission',
  blockMode: 'parked',
  createdAt: at(-760),
  toolName: 'Bash',
  input: { command: 'rm -rf dist/ && npm run build', description: 'clean rebuild' },
  matchedRule: 'deny-list: recursive delete',
  reversible: { value: false, reason: 'dist/ is gitignored — nothing to restore from' },
  cwd: WEBUI_JOB.worktreePath,
  suggestions: [
    { destination: 'localSettings', type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf dist/' }], behavior: 'allow' },
    { destination: 'session', type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf dist/' }], behavior: 'allow' },
  ],
};

const eFrames = [
  {
    type: 'hello',
    seq: 0,
    snapshot: {
      projects: [WEBUI, PROJECT],
      jobs: [WEBUI_JOB, JOB],
      agents: [UIUX, BUILDER],
      pending: [PERMISSION_REQ, QUESTION_REQ],
      servers: [],
      seq: 0,
      slots: { used: 2, total: 7 },
      costToday: 4.18,
    },
  },
];

writeFileSync(
  join(HERE, 'permission-requests.jsonl'),
  eFrames.map((f) => JSON.stringify(f)).join('\n') + '\n',
);
console.log(`permission-requests.jsonl — ${eFrames.length} frames, 2 pending (1 parked/aged, 1 held question)`);

// ─────────────────────────────────────────────────────────────────────────────
// Lane C's fixture (Amendment 80): session-basic, plus a project whose agent runs on
// OpenRouter. It reports tokens and no dollars, so it shows no cost anywhere, and its
// budget is a token cap. session-basic.jsonl itself is untouched.
// ─────────────────────────────────────────────────────────────────────────────

const DOCS = {
  id: 'prj_docs',
  name: 'docs-site',
  path: '/Users/you/src/docs-site',
  defaultBranch: 'main',
  createdAt: at(-5400),
};
const DOCS_JOB = {
  id: 'job_docs',
  projectId: DOCS.id,
  prompt: 'The API reference still documents v1 refresh tokens. Bring it up to date with the rotation change.',
  isolation: 'worktree',
  worktreePath: '/Users/you/src/docs-site/.conductor/wt/job_docs',
  branch: 'docs/token-rotation',
  status: 'working',
  createdAt: at(-60),
  endedAt: null,
  // The job's cap is in dollars, and a token-capped agent has none.
  budgetUsd: null,
};
const SCRIBE = {
  id: 'agt_scribe',
  jobId: DOCS_JOB.id,
  projectId: DOCS.id,
  role: 'scribe',
  model: 'anthropic/claude-sonnet-4.5',
  sdkSessionId: 'copilot_5d0c2e9a-71b4-4f03-a2c8-3b6e9f1d0a47',
  status: 'working',
  blockMode: null,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  dependsOn: [],
  startedAt: at(-58),
  endedAt: null,
  autonomy: { ...autonomy, budgetUsd: null, budgetTokens: 500_000 },
  provider: 'openrouter',
};

const pFrames = frames.map((f) => structuredClone(f));
const pHello = pFrames[0];
pHello.snapshot.projects.push(DOCS);
pHello.snapshot.jobs.push(DOCS_JOB);
pHello.snapshot.agents.push(SCRIBE);

// It is in the snapshot from the start; its own events follow session-basic's.
let pSeq = seq;
const pev = (sec, payload) => ({
  type: 'events',
  events: [{ seq: ++pSeq, ts: at(sec), projectId: DOCS.id, jobId: DOCS_JOB.id, agentId: SCRIBE.id, payload }],
});
const scribeFrames = [
  pev(-58, { kind: 'user_text', text: DOCS_JOB.prompt }),
  pev(-57, { kind: 'status', status: 'working' }),
  pev(-50, { kind: 'text', text: 'Reading the reference pages that mention refresh tokens.' }),
  pev(-49, { kind: 'tool_start', toolUseId: 'tu_d1', tool: 'Read', input: { file_path: 'reference/auth.md' }, label: 'Read reference/auth.md' }),
  pev(-48, { kind: 'tool_end', toolUseId: 'tu_d1', ok: true, summary: '214 lines', durationMs: 30 }),
  pev(-30, { kind: 'tool_start', toolUseId: 'tu_d2', tool: 'Edit', input: { file_path: 'reference/auth.md' }, label: 'Edit reference/auth.md' }),
  pev(-29, { kind: 'tool_end', toolUseId: 'tu_d2', ok: true, summary: '+31 −12', durationMs: 90 }),
  pev(-29, { kind: 'file_edit', path: 'reference/auth.md', added: 31, removed: 12 }),
  // No dollars: OpenRouter's runs report tokens only (Amendment 77).
  pev(-28, { kind: 'usage', costUsd: 0, inputTokens: 184_000, outputTokens: 6_200 }),
];
// The store drops an event at or below the last seq it applied, so these go last.
const providerFrames = [pHello, ...pFrames.slice(1), ...scribeFrames];

writeFileSync(
  join(HERE, 'providers.jsonl'),
  providerFrames.map((f) => JSON.stringify(f)).join('\n') + '\n',
);
console.log(`providers.jsonl — ${providerFrames.length} frames: session-basic, plus one OpenRouter agent with a token cap`);
