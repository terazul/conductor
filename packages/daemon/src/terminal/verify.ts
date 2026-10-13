/**
 * Amendment 112 verify: a full terminal on macOS and Ubuntu.
 *
 * A real shell on a real pseudo-terminal, over the real routes and socket, against a daemon
 * built in this process. It checks that a command echoes and its output comes back, that
 * resize reaches the shell, that a page attaching again is replayed what it missed (and no
 * more than 512 KB of it), that DELETE ends the shell and what it was running, that 16 is the
 * most live at once, that an unknown id is 404, that a foreign Origin is refused on the
 * socket, that removing an agent, a job or a project ends its shells, that stopping the
 * daemon does, that with CONDUCTOR_TOKEN set a page opens this socket and the feed with
 * ?token= alone (Amendment 137), and that a page which cannot keep up pauses the shell instead of filling
 * memory. If no PTY loads on this machine it prints a SKIP line, and checks that the command
 * runner is what the Agent screen is left with.
 *
 * The shell is /bin/sh with a home of its own, so nobody's profile can slow it or change what
 * it prints. Run:
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/terminal/verify.ts
 * If interrupted: lsof -ti :7829 | xargs kill -9
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TermInfo, TermListResponse } from '@conductor/shared';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { DEFAULT_AUTONOMY, insertAgent, insertJob } from '../session/store.js';
import { forcePtyUnavailable, ptyStatus } from './pty.js';
import { REPLAY_BYTES, Ring } from './ring.js';
import { parseClientFrame } from '../routes/term.js';
import { MAX_TERMINALS, clampSize, terminals, type Viewer } from './service.js';
import { pickShell, terminalEnv } from './shell.js';

const PORT = 7829;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = join(realpathSync(tmpdir()), `conductor-term-verify-${Date.now()}`);

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await sleep(20);
  }
  return true;
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ── a page: the socket, as a browser holds it ────────────────────────────────

interface Page {
  ws: WebSocket;
  opened: Promise<boolean>;
  closed: Promise<{ code: number; reason: string }>;
  chunks: Buffer[];
  text(): string;
  bytes(): number;
  type(d: string): void;
  resize(cols: number, rows: number): void;
  waitFor(re: RegExp, ms?: number): Promise<RegExpMatchArray | null>;
  close(): void;
}

function attach(id: string, origin?: string): Page {
  // Node's WebSocket takes headers, so Origin can be set as a browser page would.
  const init = origin ? ({ headers: { origin } } as unknown as string[]) : undefined;
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/term/${id}`, init);
  ws.binaryType = 'arraybuffer';
  const chunks: Buffer[] = [];
  const opened = new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (e) => resolve({ code: e.code, reason: e.reason });
  });
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) chunks.push(Buffer.from(e.data));
  };
  const text = () => Buffer.concat(chunks).toString('utf8');
  return {
    ws,
    opened,
    closed,
    chunks,
    text,
    bytes: () => chunks.reduce((n, c) => n + c.length, 0),
    type: (d) => ws.send(JSON.stringify({ t: 'in', d })),
    resize: (cols, rows) => ws.send(JSON.stringify({ t: 'resize', cols, rows })),
    async waitFor(re, ms = 5_000) {
      let m: RegExpMatchArray | null = null;
      await until(() => (m = text().match(re)) !== null, ms);
      return m;
    },
    close: () => ws.close(),
  };
}

const list = async (agentId: string) => (await send<TermListResponse>('GET', `/api/agents/${agentId}/terminals`)).body;
const open = async (agentId: string, size?: { cols: number; rows: number }) => {
  const r = await send<{ id: string; error?: string }>('POST', `/api/agents/${agentId}/terminals`, size ?? {});
  return r;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=v@example.invalid', '-c', 'user.name=v', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = join(ROOT, 'conductor.db');
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n1 · the parts that need no shell');
  {
    const r = new Ring(10);
    r.push(Buffer.from('abcdef'));
    r.push(Buffer.from('ghijkl'));
    check('the ring keeps the last `limit` bytes, oldest dropped', r.size === 10 && r.snapshot().toString() === 'cdefghijkl', r.snapshot().toString());
    const big = new Ring(4);
    big.push(Buffer.from('0123456789'));
    check('one chunk bigger than the limit is cut to its tail', big.snapshot().toString() === '6789');
    const u = new Ring(5);
    u.push(Buffer.from('héllo')); // h, 0xC3 0xA9, l, l, o : 6 bytes
    check('a cut inside a character drops its orphaned bytes instead of opening with garbage', u.snapshot().toString('utf8') === 'llo' || u.snapshot().toString('utf8') === 'éllo', JSON.stringify(u.snapshot().toString('utf8')));
    check('the replay is 512 KB', REPLAY_BYTES === 512 * 1024 && new Ring().limit === 512 * 1024);

    const there = (...ok: string[]) => (p: string) => ok.includes(p);
    check('the shell is $SHELL with -l', JSON.stringify(pickShell({ SHELL: '/bin/zsh' }, there('/bin/zsh', '/bin/bash', '/bin/sh'))) === '{"file":"/bin/zsh","args":["-l"]}');
    check('a $SHELL that is not there falls back to bash', pickShell({ SHELL: '/nope/zsh' }, there('/bin/bash', '/bin/sh')).file === '/bin/bash');
    check('no $SHELL: bash; no bash: sh', pickShell({}, there('/bin/bash', '/bin/sh')).file === '/bin/bash' && pickShell({}, there('/bin/sh')).file === '/bin/sh');
    const env = terminalEnv({ PATH: '/usr/bin', NO_COLOR: '1', CONDUCTOR_TOKEN: 'secret', TERM: 'dumb', GONE: undefined });
    check('TERM=xterm-256color, COLORTERM=truecolor, NO_COLOR and the token removed, the rest kept', env['TERM'] === 'xterm-256color' && env['COLORTERM'] === 'truecolor' && !('NO_COLOR' in env) && !('CONDUCTOR_TOKEN' in env) && env['PATH'] === '/usr/bin' && !('GONE' in env), JSON.stringify(env));
    check('what a page sends is parsed, and nothing else is', JSON.stringify(parseClientFrame('{"t":"in","d":"ls\\n"}')) === '{"t":"in","d":"ls\\n"}' && parseClientFrame('{"t":"resize","cols":100,"rows":30}')?.t === 'resize' && parseClientFrame('{"t":"in","d":5}') === null && parseClientFrame('{"t":"rm"}') === null && parseClientFrame('not json') === null && parseClientFrame('null') === null);
    check('a size is a whole number of cells, never absurd', clampSize(0, 24) === 1 && clampSize(9999, 24) === 500 && clampSize(NaN, 24) === 24 && clampSize('x', 24) === 24 && clampSize(80.4, 24) === 80);
    check('the cap is 16', MAX_TERMINALS === 16);
    const win = ptyStatus('win32');
    check('Windows is not built: the runner is what it gets, and it says so', !win.available && /macOS and Ubuntu/.test(win.available ? '' : win.reason));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // A project, a job and agents, in a folder of their own.
  writeFileSync(join(ROOT, 'README.md'), '# term verify\n');
  git(ROOT, 'init', '-q', '-b', 'main');
  git(ROOT, 'add', '.');
  git(ROOT, 'commit', '-q', '-m', 'init');
  const WT = join(ROOT, '.conductor', 'wt', 'job_t');
  const WT2 = join(ROOT, '.conductor', 'wt', 'job_u');
  mkdirSync(WT, { recursive: true });
  mkdirSync(WT2, { recursive: true });

  // Nobody's profile in the way, and nothing of the real home touched.
  process.env['HOME'] = join(ROOT, 'home');
  mkdirSync(process.env['HOME'], { recursive: true });
  process.env['SHELL'] = '/bin/sh';
  process.env['NO_COLOR'] = '1';
  process.env['CONDUCTOR_TOKEN'] = 'must-not-reach-the-shell';

  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });
  const db = openDb();
  const added = await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'term-verify' });
  const projectId = added.body.project.id;
  const job = (id: string, path: string) =>
    insertJob(db, { id, projectId, prompt: 'work', isolation: 'worktree', worktreePath: path, branch: `conductor/${id}`, status: 'done', budgetUsd: null });
  const agent = (id: string, jobId: string) =>
    insertAgent(db, {
      id, jobId, projectId, role: 'architect', model: 'claude-sonnet-5', sdkSessionId: null, status: 'done',
      blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: DEFAULT_AUTONOMY,
    });
  job('job_t', WT);
  job('job_u', WT2);
  agent('agt_t', 'job_t');
  agent('agt_u', 'job_u');
  agent('agt_u2', 'job_u');
  const mgr = terminals();

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n2 · when no PTY loads, the command runner is what is left');
  {
    forcePtyUnavailable('The terminal library (@lydell/node-pty) did not load on test-1: forced by verify');
    const l = await list('agt_t');
    check('GET says available: false, with the reason, and no terminals', l.available === false && /did not load/.test(l.reason ?? '') && l.terminals.length === 0, JSON.stringify(l));
    const no = await open('agt_t');
    check('POST is refused with 503 and a sentence', no.status === 503 && /did not load/.test(no.body.error ?? ''), JSON.stringify(no));
    check('and nothing was started', mgr.live === 0);
    const ran = await send<{ run: { id: string } }>('POST', '/api/agents/agt_t/terminal', { command: 'echo runner-ok' });
    check('the old runner still takes a command', ran.status === 201, JSON.stringify(ran.body));
    let out = '';
    const ok = await (async () => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const h = await send<{ runs: { endedAt: string | null; output: { text: string }[] }[] }>('GET', '/api/agents/agt_t/terminal');
        const r = h.body.runs.at(-1);
        if (r?.endedAt) {
          out = r.output.map((c) => c.text).join('');
          return true;
        }
        await sleep(50);
      }
      return false;
    })();
    check('and returns its output', ok && /runner-ok/.test(out), out);
    forcePtyUnavailable(null);
  }

  if (!ptyStatus().available) {
    const s = ptyStatus();
    console.log(`\nSKIP: no PTY on this machine, so the real-terminal sections (3 to 11) did not run: ${s.available ? '' : s.reason}`);
    await app.close();
    rmSync(ROOT, { recursive: true, force: true });
    console.log(
      failures === 0
        ? `\nAmendment 112 terminal: PASS (PTY SKIPPED) — ${checks} checks: the fallback holds.\n`
        : `\nAmendment 112 terminal: FAIL — ${failures} of ${checks} check(s) failed.\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n3 · open one, type a command, read what it printed');
  const first = await open('agt_t', { cols: 90, rows: 20 });
  const id = first.body.id;
  check('POST → 201 with an id', first.status === 201 && /^term_[0-9a-f]+$/.test(id), JSON.stringify(first));
  const l1 = await list('agt_t');
  const info = l1.terminals[0] as TermInfo | undefined;
  check('GET lists it: available, its folder, when it started, not exited', l1.available === true && l1.terminals.length === 1 && info?.id === id && info.cwd === WT && !info.exited && !Number.isNaN(Date.parse(info.startedAt)), JSON.stringify(l1));
  check('another agent has none', (await list('agt_u')).terminals.length === 0);

  const p1 = attach(id);
  check('the socket opens', await p1.opened);
  p1.type('echo hello-$((6*7))\n');
  check('a command is run and its output comes back', (await p1.waitFor(/hello-42/)) !== null, p1.text());
  p1.type('echo "T=$TERM C=$COLORTERM N=${NO_COLOR-unset} K=${CONDUCTOR_TOKEN-unset}"\n');
  check('TERM and COLORTERM are set; NO_COLOR and the token are not there', (await p1.waitFor(/T=xterm-256color C=truecolor N=unset K=unset/)) !== null, p1.text().slice(-300));
  p1.type('pwd -P\n');
  check("it starts in the agent's folder", (await p1.waitFor(new RegExp(`\\r\\n${WT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r\\n`))) !== null, p1.text().slice(-300));
  p1.type('stty size\n');
  check('and was created at the size the page asked for (20 rows, 90 columns)', (await p1.waitFor(/\r\n20 90\r\n/)) !== null, p1.text().slice(-200));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n4 · resize reaches the shell');
  p1.resize(120, 33);
  await sleep(100);
  p1.type('stty size\n');
  check('stty size follows the page: 33 rows, 120 columns', (await p1.waitFor(/\r\n33 120\r\n/)) !== null, p1.text().slice(-200));
  p1.ws.send('this is not json');
  p1.ws.send(JSON.stringify({ t: 'resize', cols: 'x' }));
  p1.type('echo still-here\n');
  check('and a frame it cannot read is ignored, not fatal', (await p1.waitFor(/still-here/)) !== null);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n5 · the page closes, the shell does not; a new page is replayed');
  p1.type('echo SH=$$\n');
  const sh = await p1.waitFor(/SH=(\d+)/);
  const shellPid = Number(sh?.[1]);
  p1.close();
  await p1.closed;
  await sleep(150);
  check('closing the page leaves the shell running', alive(shellPid) && !(await list('agt_t')).terminals[0]?.exited);
  const p2 = attach(id);
  await p2.opened;
  check('a new page gets what it missed, first: the earlier output', (await p2.waitFor(/hello-42[\s\S]*33 120[\s\S]*still-here/, 3000)) !== null, p2.text().slice(-300));
  p2.type('echo after-reattach\n');
  check('and is live after it', (await p2.waitFor(/after-reattach\r\n/)) !== null);
  const p2b = attach(id);
  await p2b.opened;
  p2b.type('echo from-the-second-page\n');
  check('a second page on the same terminal sees the same stream', (await p2b.waitFor(/from-the-second-page\r\n/)) !== null && (await p2.waitFor(/from-the-second-page\r\n/)) !== null);
  p2b.close();

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n6 · the replay is the last 512 KB');
  p2.type("yes abcdefghijklmnopqrstuvwxyz0123456789 | head -c 900000; echo; echo TAIL-MARK-$((1+1))\n");
  check('it ran', (await p2.waitFor(/TAIL-MARK-2/, 15_000)) !== null);
  p2.close();
  await p2.closed;
  const p3 = attach(id);
  await p3.opened;
  await until(() => /TAIL-MARK-2/.test(p3.text()), 5_000);
  await sleep(100);
  check('a page attaching afterwards gets at most 512 KB', p3.bytes() <= REPLAY_BYTES && p3.bytes() > REPLAY_BYTES - 4096, `${p3.bytes()} bytes`);
  check('and it is the end of the output, not the start', /TAIL-MARK-2/.test(p3.text()) && !/hello-42/.test(p3.text()));
  p3.close();
  await p3.closed;

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n7 · DELETE ends the shell and what it was running');
  const p4 = attach(id);
  await p4.opened;
  p4.type("sh -c 'echo CH=$$; exec sleep 300'\n");
  const ch = await p4.waitFor(/CH=(\d+)/);
  const childPid = Number(ch?.[1]);
  check('a foreground command is running under the shell', alive(childPid) && alive(shellPid), `child ${childPid} shell ${shellPid}`);
  const del = await send<{ closed: boolean }>('DELETE', `/api/terminals/${id}`);
  check('DELETE → 200', del.status === 200 && del.body.closed === true, JSON.stringify(del));
  check('the shell is gone', await until(() => !alive(shellPid), 4_000), `pid ${shellPid}`);
  check('and so is what it was running', await until(() => !alive(childPid), 4_000), `pid ${childPid}`);
  const gone = await p4.closed;
  check('the page is told: the socket closes normally', gone.code === 1000, JSON.stringify(gone));
  check('it is no longer listed', (await list('agt_t')).terminals.length === 0);
  const again = await send<{ error: string }>('DELETE', `/api/terminals/${id}`);
  check('deleting it again → 404', again.status === 404 && /no such terminal/.test(again.body.error), JSON.stringify(again));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n8 · what is not there is 404');
  const nope = await send<{ error: string }>('DELETE', '/api/terminals/term_nothing');
  check('DELETE of an unknown id → 404', nope.status === 404 && /no such terminal/.test(nope.body.error), JSON.stringify(nope));
  check('GET for an unknown agent → 404', (await send('GET', '/api/agents/agt_nope/terminals')).status === 404);
  check('POST for an unknown agent → 404', (await send('POST', '/api/agents/agt_nope/terminals', {})).status === 404);
  const ghost = attach('term_nothing');
  await ghost.opened;
  const ghostEnd = await ghost.closed;
  check('the socket for an unknown id is closed with 4404', ghostEnd.code === 4404, JSON.stringify(ghostEnd));

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n9 · a shell that exits is said to have, and does not count against the cap');
  const ex = (await open('agt_t')).body.id;
  const p5 = attach(ex);
  await p5.opened;
  p5.type('echo bye-now; exit 3\n');
  const end = await p5.closed;
  check('the socket closes normally when the shell exits', end.code === 1000 && end.reason === 'exited', JSON.stringify(end));
  check('the output before it was delivered', /bye-now/.test(p5.text()));
  const exl = (await list('agt_t')).terminals.find((t) => t.id === ex);
  check('it stays listed as exited, with its code', exl?.exited === true && exl.exitCode === 3, JSON.stringify(exl));
  check('it is not a live shell', mgr.live === 0);
  const p6 = attach(ex);
  await p6.opened;
  const end6 = await p6.closed;
  check('a page opening it later gets its output, then is closed on', /bye-now/.test(p6.text()) && end6.code === 1000);
  check('typing into it does nothing, and does not throw', (() => { mgr.write(ex, 'x'); mgr.resize(ex, 10, 10); return true; })());
  check('closing it forgets it', (await send('DELETE', `/api/terminals/${ex}`)).status === 200 && (await list('agt_t')).terminals.length === 0);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n10 · at most 16 are live');
  const ids: string[] = [];
  for (let i = 0; i < MAX_TERMINALS; i++) {
    const r = await open(i % 2 === 0 ? 'agt_t' : 'agt_u');
    if (r.status === 201) ids.push(r.body.id);
  }
  check('16 open', ids.length === 16 && mgr.live === 16, `${ids.length} / ${mgr.live}`);
  const over = await open('agt_t');
  check('the 17th is refused with 409 and a sentence', over.status === 409 && /16 terminals are open already\. Close one first\./.test(over.body.error ?? ''), JSON.stringify(over));
  check('and none was started', mgr.live === 16);
  const one = ids[0]!;
  await send('DELETE', `/api/terminals/${one}`);
  const room = await open('agt_t');
  check('closing one makes room', room.status === 201 && mgr.live === 16, JSON.stringify(room));
  await Promise.all([...ids.slice(1), room.body.id].map((i) => send('DELETE', `/api/terminals/${i}`)));
  check('all closed', mgr.live === 0 && (await list('agt_t')).terminals.length === 0 && (await list('agt_u')).terminals.length === 0);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n11 · the socket is as local-only as every other route');
  const live = (await open('agt_t')).body.id;
  const foreign = attach(live, 'https://evil.example');
  check('a page from another site cannot attach (Origin refused)', (await foreign.opened) === false);
  const nullOrigin = attach(live, 'null');
  check('nor a sandboxed or file page (Origin: null)', (await nullOrigin.opened) === false);
  const local = attach(live, 'http://localhost:5173');
  check('a local page can', await local.opened);
  local.type('echo local-ok\n');
  check('and gets its shell', (await local.waitFor(/local-ok\r\n/)) !== null);
  local.close();
  await local.closed;
  // A refused handshake may or may not report a close; either way nothing is left open.
  await Promise.race([Promise.all([foreign.closed, nullOrigin.closed]), sleep(500)]);
  check('and a refused page never saw a byte of the shell', foreign.bytes() === 0 && nullOrigin.bytes() === 0);
  const bare = await fetch(`${BASE}/api/agents/agt_t/terminals`, { headers: { origin: 'https://evil.example' } });
  check('and the routes refuse a foreign Origin too', bare.status === 403);
  const rebind = await fetch(`${BASE}/api/agents/agt_t/terminals`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  check('so a page cannot open a shell by POST either', rebind.status === 403 && mgr.live === 1, `${rebind.status} live ${mgr.live}`);
  await send('DELETE', `/api/terminals/${live}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n12 · removing an agent, a job or a project ends its shells');
  const aT = (await open('agt_t')).body.id;
  const aU = (await open('agt_u')).body.id;
  const aU2 = (await open('agt_u2')).body.id;
  const pid = async (termId: string): Promise<number> => {
    const pg = attach(termId);
    await pg.opened;
    pg.type('echo P=$$\n');
    const m = await pg.waitFor(/P=(\d+)/);
    pg.close();
    return Number(m?.[1]);
  };
  const [pidT, pidU, pidU2] = [await pid(aT), await pid(aU), await pid(aU2)];
  check('three shells, three processes', mgr.live === 3 && [pidT, pidU, pidU2].every((p) => p > 0 && alive(p)), `${pidT} ${pidU} ${pidU2}`);
  const rmAgent = await send('DELETE', '/api/agents/agt_u');
  check('removing an agent → 200', rmAgent.status === 200, JSON.stringify(rmAgent.body));
  check('its shell ends', await until(() => !alive(pidU), 4_000));
  check("and it is no longer listed; its job-mate's and the other agent's are", mgr.get(aU) === null && mgr.get(aU2) !== null && mgr.get(aT) !== null && alive(pidU2) && alive(pidT));
  const rmJob = await send('DELETE', '/api/jobs/job_u');
  check('removing a job → 200', rmJob.status === 200, JSON.stringify(rmJob.body));
  check("its remaining agent's shell ends", await until(() => !alive(pidU2), 4_000) && mgr.get(aU2) === null);
  check("and the other job's does not", alive(pidT) && mgr.get(aT) !== null);
  const rmProject = await send('DELETE', `/api/projects/${projectId}`);
  check('removing the project → 200', rmProject.status === 200, JSON.stringify(rmProject.body));
  check('the last shell ends', await until(() => !alive(pidT), 4_000) && mgr.get(aT) === null && mgr.live === 0);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n13 · a page that cannot keep up pauses the shell');
  // The manager directly, with a viewer whose queue is as long as we say. `yes` never stops
  // on its own: whatever is received is what the shell was allowed to write.
  const slowJob = join(ROOT, 'slow');
  mkdirSync(slowJob, { recursive: true });
  const slow = mgr.create({ agentId: 'agt_slow', jobId: 'job_slow', cwd: slowJob });
  let behind = 8 * 1024 * 1024;
  let got = 0;
  const viewer: Viewer = { send: (d) => void (got += d.length), backlog: () => behind, close: () => undefined };
  const att = mgr.attach(slow.id, viewer)!;
  mgr.write(slow.id, 'yes\n');
  await sleep(600);
  const whileBehind = got;
  await sleep(300);
  check('with its queue full, the output stops (a few buffers at most, not megabytes)', got === whileBehind && got < 1024 * 1024, `${got} bytes, was ${whileBehind}`);
  behind = 0;
  check('and it carries on when the queue has drained', await until(() => got > whileBehind + 2 * 1024 * 1024, 4_000), `${got} bytes`);
  att.detach();
  const killed = Date.now();
  await mgr.close(slow.id);
  check('a busy shell is still ended by close, inside the 3 s it is given before SIGKILL', Date.now() - killed < 3_500, `${Date.now() - killed} ms`);
  check('and it is forgotten', mgr.get(slow.id) === null && mgr.live === 0);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n14 · stopping the daemon ends every shell');
  // The project is gone; a new one for the same folder, with an agent to hold the shell.
  const again2 = await send<{ project: { id: string } }>('POST', '/api/projects', { path: ROOT, name: 'term-verify-2' });
  const pj = again2.body.project.id;
  insertJob(db, { id: 'job_v', projectId: pj, prompt: 'work', isolation: 'worktree', worktreePath: WT, branch: 'conductor/job_v', status: 'done', budgetUsd: null });
  insertAgent(db, {
    id: 'agt_v', jobId: 'job_v', projectId: pj, role: 'architect', model: 'claude-sonnet-5', sdkSessionId: null, status: 'done',
    blockMode: null, costUsd: 0, inputTokens: 0, outputTokens: 0, dependsOn: [], autonomy: DEFAULT_AUTONOMY,
  });
  const last = (await open('agt_v')).body.id;
  const lastPid = await (async () => {
    const pg = attach(last);
    await pg.opened;
    pg.type("sh -c 'echo L=$$; exec sleep 300'\n");
    const m = await pg.waitFor(/L=(\d+)/);
    pg.close();
    return Number(m?.[1]);
  })();
  check('a shell is running a command', alive(lastPid) && mgr.live === 1);
  await app.close();
  check('after the daemon closes, the shell and its command are gone', await until(() => !alive(lastPid), 4_000) && mgr.live === 0, `pid ${lastPid}`);

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n15 · with CONDUCTOR_TOKEN set, a browser opens both sockets with ?token= alone (Amendment 137)');
  {
    // The token is read once, when index.ts loads, so a daemon that has one is another process.
    const TOKEN_PORT = 7830;
    const tokenDb = join(ROOT, 'token.db');
    const child = spawn('tsx', ['--no-warnings=ExperimentalWarning', 'src/index.ts'], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, CONDUCTOR_TOKEN: 'sekret', CONDUCTOR_DB: tokenDb, CONDUCTOR_PORT: String(TOKEN_PORT), LOG_LEVEL: 'silent' },
      stdio: 'ignore',
      detached: true,
    });
    const stop = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
    };
    let up = false;
    for (let i = 0; i < 400 && !up; i++) {
      up = await fetch(`http://127.0.0.1:${TOKEN_PORT}/api/health`).then((r) => r.status === 401, () => false);
      if (!up) await sleep(50);
    }
    check('a daemon with a token answers 401 to a request without it', up);
    if (up) {
      // A browser cannot set Authorization on a WebSocket; Node's can, so the header is
      // sent only where a check says so, and Origin is set as a page would set it.
      const reaches = (path: string, query: string, opts: { bearer?: boolean; origin?: string } = {}) =>
        new Promise<boolean>((resolve) => {
          const headers: Record<string, string> = {};
          if (opts.bearer) headers['authorization'] = 'Bearer sekret';
          if (opts.origin) headers['origin'] = opts.origin;
          const init = Object.keys(headers).length ? ({ headers } as unknown as string[]) : undefined;
          const ws = new WebSocket(`ws://127.0.0.1:${TOKEN_PORT}${path}${query}`, init);
          ws.onopen = () => {
            ws.close();
            resolve(true);
          };
          ws.onerror = () => resolve(false);
        });
      for (const [name, path] of [['the feed socket', '/ws'], ['the terminal socket', '/ws/term/term_none']] as const) {
        check(`${name} is reached with the right ?token= alone, as a browser sends it`, (await reaches(path, '?token=sekret')) === true);
        check(`${name} is refused with no token`, (await reaches(path, '')) === false);
        check(`${name} is refused with a bearer header but no ?token=`, (await reaches(path, '', { bearer: true })) === false);
        check(`${name} is refused with a wrong ?token= of the same length`, (await reaches(path, '?token=sekreT')) === false);
        check(`${name} is refused with a wrong ?token=, even with the bearer header`, (await reaches(path, '?token=wrong', { bearer: true })) === false);
        check(`${name} is refused with a ?token= shorter or longer than the token`, (await reaches(path, '?token=sekre')) === false && (await reaches(path, '?token=sekrett')) === false);
        check(`${name} is refused from a foreign Origin, even with the right ?token= (the guard runs first)`, (await reaches(path, '?token=sekret', { origin: 'https://evil.example' })) === false);
        check(`${name} is reached from a local Origin with the right ?token=`, (await reaches(path, '?token=sekret', { origin: 'http://localhost:5173' })) === true);
      }
      const get = (path: string, bearer: boolean) =>
        fetch(`http://127.0.0.1:${TOKEN_PORT}${path}`, bearer ? { headers: { authorization: 'Bearer sekret' } } : {}).then((r) => r.status);
      check('a plain HTTP request is not let in by ?token= (still 401)', (await get('/api/health?token=sekret', false)) === 401);
      check('nor a GET to the socket paths without an upgrade', (await get('/ws?token=sekret', false)) === 401 && (await get('/ws/term/term_none?token=sekret', false)) === 401);
      check('a plain HTTP request with the bearer header is answered', (await get('/api/health', true)) === 200);
      check('and a wrong bearer header is 401', (await fetch(`http://127.0.0.1:${TOKEN_PORT}/api/health`, { headers: { authorization: 'Bearer sekreT' } }).then((r) => r.status)) === 401);
    }
    stop();
  }

  rmSync(ROOT, { recursive: true, force: true });
  console.log(
    failures === 0
      ? `\nAmendment 112 terminal: PASS — ${checks} checks: a real shell echoes, resizes and replays; DELETE, an agent, a job, a project and the daemon's stop each end it; 16 is the most; an unknown id is 404; a foreign Origin is refused on the socket.\n`
      : `\nAmendment 112 terminal: FAIL — ${failures} of ${checks} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/*
 * An awaited promise that never settles empties the event loop, and Node then exits 0
 * without a verdict. Make that a failure.
 */
let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.error('\nAmendment 112 terminal: FAIL — the run never reached its verdict.\n');
    process.exitCode = 1;
  }
});

main()
  .then(() => (finished = true))
  .catch((err) => {
    console.error('verify crashed', err);
    rmSync(ROOT, { recursive: true, force: true });
    process.exit(1);
  });
