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
 * Amendment 141 adds: a page reattaching is sent the headless mirror's screen, so a full-screen
 * program's screen (the alternate screen, the cursor) is drawn right, and the scrollback setting
 * bounds it; with the mirror off it is the raw 512 KB as before; bytes that are not text (`bin`)
 * reach the shell as bytes; a project's terminals open in the project folder, are listed apart
 * from an agent's, close, and end with the project; the hub's `terminals` frame follows each
 * change; and the three settings are refused out of range, and the shell one is what runs.
 *
 * The shell is /bin/sh with a home of its own, so nobody's profile can slow it or change what
 * it prints. Run:
 *   pnpm --filter @conductor/daemon exec tsx --no-warnings=ExperimentalWarning src/terminal/verify.ts
 * If interrupted: lsof -ti :7829 | xargs kill -9
 */

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerFrame, TermInfo, TermListResponse, TermShellsResponse } from '@conductor/shared';
import { build } from '../index.js';
import { openDb } from '../db/index.js';
import { DEFAULT_AUTONOMY, insertAgent, insertJob } from '../session/store.js';
import { forcePtyUnavailable, ptyStatus } from './pty.js';
import { forceMirrorUnavailable, mirrorStatus } from './mirror.js';
import { REPLAY_BYTES, Ring } from './ring.js';
import { parseClientFrame } from '../routes/term.js';
import { MAX_TERMINALS, clampSize, terminals, type Viewer } from './service.js';
import { findShells, pickShell, terminalEnv } from './shell.js';

/** The page's xterm.js, without a page: what a replay draws is read back from its buffer. */
interface Headless {
  write(d: string | Uint8Array, cb?: () => void): void;
  buffer: { active: { type: string; length: number; cursorX: number; cursorY: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } };
}
const { Terminal: HeadlessTerminal } = createRequire(import.meta.url)('@xterm/headless') as {
  Terminal: new (o: { cols: number; rows: number; scrollback?: number; allowProposedApi?: boolean }) => Headless;
};
/** Draw `bytes` in an empty terminal of this size (then `after`, if given) and return what its screen shows. */
async function drawn(bytes: Buffer, cols: number, rows: number, after = ''): Promise<{ type: string; lines: string[]; all: string[]; cursor: [number, number] }> {
  const t = new HeadlessTerminal({ cols, rows, scrollback: 100_000, allowProposedApi: true });
  await new Promise<void>((r) => t.write(new Uint8Array(bytes), r));
  if (after) await new Promise<void>((r) => t.write(after, r));
  const b = t.buffer.active;
  const all: string[] = [];
  for (let i = 0; i < b.length; i++) all.push(b.getLine(i)?.translateToString(true) ?? '');
  return { type: b.type, lines: all.slice(-rows), all, cursor: [b.cursorX, b.cursorY] };
}

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
    const etc = '# /etc/shells: valid login shells\n/bin/bash\n/bin/zsh\n\n/usr/local/bin/zsh  # brew\n/bin/gone\nnot-a-path\n';
    const found = findShells({ SHELL: '/usr/local/bin/fish' }, there('/usr/local/bin/fish', '/bin/bash', '/bin/zsh', '/usr/local/bin/zsh', '/bin/sh'), etc);
    check('the shells found (141): $SHELL first, then /etc/shells, then sh; only those there, no comments, no relative names, no repeats', JSON.stringify(found.map((s) => s.path)) === JSON.stringify(['/usr/local/bin/fish', '/bin/bash', '/bin/zsh', '/usr/local/bin/zsh', '/bin/sh']), JSON.stringify(found));
    check('two with the same name are told apart by their path', found.find((s) => s.path === '/bin/zsh')?.label === 'zsh · /bin/zsh' && found.find((s) => s.path === '/bin/bash')?.label === 'bash', JSON.stringify(found));
    check('the setting picks one of those', pickShell({ SHELL: '/usr/local/bin/fish' }, there('/usr/local/bin/fish', '/bin/zsh'), '/bin/zsh', found).file === '/bin/zsh');
    check('a setting naming one not found, or not there now, is passed over for $SHELL', pickShell({ SHELL: '/bin/bash' }, there('/bin/bash'), '/bin/nope', found).file === '/bin/bash' && pickShell({ SHELL: '/bin/bash' }, there('/bin/bash'), '/bin/zsh', found).file === '/bin/bash');
    const env = terminalEnv({ PATH: '/usr/bin', NO_COLOR: '1', CONDUCTOR_TOKEN: 'secret', TERM: 'dumb', GONE: undefined });
    check('TERM=xterm-256color, COLORTERM=truecolor, NO_COLOR and the token removed, the rest kept', env['TERM'] === 'xterm-256color' && env['COLORTERM'] === 'truecolor' && !('NO_COLOR' in env) && !('CONDUCTOR_TOKEN' in env) && env['PATH'] === '/usr/bin' && !('GONE' in env), JSON.stringify(env));
    check('what a page sends is parsed, and nothing else is', JSON.stringify(parseClientFrame('{"t":"in","d":"ls\\n"}')) === '{"t":"in","d":"ls\\n"}' && parseClientFrame('{"t":"resize","cols":100,"rows":30}')?.t === 'resize' && parseClientFrame('{"t":"in","d":5}') === null && parseClientFrame('{"t":"rm"}') === null && parseClientFrame('not json') === null && parseClientFrame('null') === null);
    check('bytes that are not text (141) come as base64, and anything that is not base64 is dropped', parseClientFrame('{"t":"bin","d":"G1tNIPz/"}')?.t === 'bin' && parseClientFrame('{"t":"bin","d":"not base64!"}') === null && parseClientFrame('{"t":"bin","d":"abc"}') === null && parseClientFrame('{"t":"bin","d":7}') === null);
    check('the headless mirror loads here (141)', mirrorStatus().available, JSON.stringify(mirrorStatus()));
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
  // `od` prints the bytes it reads from the terminal, in hex, at the end-of-file (Ctrl-D).
  p1.type('od -An -tx1\n');
  await sleep(300);
  p1.ws.send(JSON.stringify({ t: 'bin', d: Buffer.from([0x41, 0xfc, 0x0a]).toString('base64') }));
  p1.type('Aü\n');
  await sleep(100);
  p1.type('\x04');
  check('bytes sent as `bin` reach the shell as bytes (41 fc), text sent as `in` as UTF-8 (41 c3 bc) (141)', (await p1.waitFor(/41\s+fc\s+0a\s+41\s+c3\s+bc\s+0a/)) !== null, p1.text().slice(-200));

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
  console.log('\n6 · a page attaching is sent the screen and its scrollback, not the last bytes (141)');
  p2.type("yes abcdefghijklmnopqrstuvwxyz0123456789 | head -c 900000; echo; echo TAIL-MARK-$((1+1))\n");
  check('it ran', (await p2.waitFor(/TAIL-MARK-2/, 15_000)) !== null);
  p2.close();
  await p2.closed;
  const p3 = attach(id);
  await p3.opened;
  await until(() => /TAIL-MARK-2/.test(p3.text()), 5_000);
  await sleep(100);
  const shown = await drawn(Buffer.concat(p3.chunks), 120, 33);
  check('what it gets is the screen and the 5,000 lines above it, far less than 512 KB', p3.bytes() < REPLAY_BYTES / 2 && shown.all.length <= 5000 + 33 && shown.all.length > 4000, `${p3.bytes()} bytes, ${shown.all.length} lines`);
  check('and it is the end of the output, not the start', shown.all.some((l) => l === 'TAIL-MARK-2') && !/hello-42/.test(p3.text()));
  p3.close();
  await p3.closed;

  console.log('\n6b · without the mirror, the replay is the last 512 KB, as before');
  forceMirrorUnavailable(true);
  const raw = (await open('agt_t', { cols: 120, rows: 33 })).body.id;
  forceMirrorUnavailable(false);
  const r1 = attach(raw);
  await r1.opened;
  r1.type("yes abcdefghijklmnopqrstuvwxyz0123456789 | head -c 900000; echo; echo TAIL-MARK-$((2+1))\n");
  check('it ran', (await r1.waitFor(/TAIL-MARK-3/, 15_000)) !== null);
  r1.close();
  await r1.closed;
  const r2 = attach(raw);
  await r2.opened;
  await until(() => /TAIL-MARK-3/.test(r2.text()), 5_000);
  await sleep(100);
  check('a page attaching afterwards gets at most 512 KB', r2.bytes() <= REPLAY_BYTES && r2.bytes() > REPLAY_BYTES - 4096, `${r2.bytes()} bytes`);
  check('and it is the end of the output, not the start', /TAIL-MARK-3/.test(r2.text()) && !/yes abcdef/.test(r2.text()));
  r2.close();
  await r2.closed;
  await send('DELETE', `/api/terminals/${raw}`);

  console.log('\n6c · reattaching mid-full-screen draws that screen (141)');
  {
    const fs = (await open('agt_t', { cols: 80, rows: 24 })).body.id;
    const f1 = attach(fs);
    await f1.opened;
    // As vim does: the alternate screen, cleared, text placed by cursor moves, the cursor left
    // mid-screen. `%s` keeps the markers out of the echoed command line.
    f1.type("printf 'before-%s\\n' full; printf '\\033[?1049h\\033[2J\\033[HFULL-%s\\033[12;30HMID%s\\033[24;1HBOTTOM-%s\\033[3;7H' SCREEN DLE LINE; sleep 300\n");
    check('the program drew its screen', (await f1.waitFor(/BOTTOM-LINE/)) !== null);
    await sleep(200);
    f1.close();
    await f1.closed;
    const f2 = attach(fs);
    await f2.opened;
    await until(() => f2.bytes() > 0, 3_000);
    await sleep(300);
    const d = await drawn(Buffer.concat(f2.chunks), 80, 24);
    check('a page attaching again is on the alternate screen, as the program is', d.type === 'alternate', d.type);
    check("each line is where the program put it", d.lines[0] === 'FULL-SCREEN' && d.lines[11] === `${' '.repeat(29)}MIDDLE` && d.lines[23] === 'BOTTOM-LINE' && d.lines.slice(1, 11).every((l) => l === ''), JSON.stringify(d.lines));
    check('and the cursor is where it was left (row 3, column 7)', d.cursor[0] === 6 && d.cursor[1] === 2, JSON.stringify(d.cursor));
    const back = await drawn(Buffer.concat(f2.chunks), 80, 24, '\x1b[?1049l');
    check('the shell screen behind it came too: leaving the program shows what was printed before', back.type === 'normal' && back.all.includes('before-full'), JSON.stringify(back.all.slice(0, 8)));
    f2.type('\x03');
    f2.type("printf '\\033[?1049l'; printf 'after-%s\\n' ok\n");
    check('and it is live after the screen: Ctrl-C reaches the program, and the shell answers', (await f2.waitFor(/after-ok\r\n/)) !== null, f2.text().slice(-200));
    f2.close();
    await f2.closed;
    await send('DELETE', `/api/terminals/${fs}`);
  }

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
  console.log("\n11b · a project's terminals, and the hub's `terminals` frame (141)");
  // The feed, as a browser tab holds it: every frame it is sent.
  const feed = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const frames: ServerFrame[] = [];
  feed.onmessage = (e) => frames.push(JSON.parse(String(e.data)) as ServerFrame);
  await new Promise<void>((r) => (feed.onopen = () => r()));
  feed.send(JSON.stringify({ type: 'subscribe', since: 0 }));
  await until(() => frames.some((f) => f.type === 'hello'));
  const termFrames = (key: string) =>
    frames.filter((f): f is Extract<ServerFrame, { type: 'terminals' }> => f.type === 'terminals' && (f.scope.kind === 'project' ? `project:${f.scope.projectId}` : `agent:${f.scope.agentId}`) === key);
  const pkey = `project:${projectId}`;
  {
    const plist = async () => (await send<TermListResponse>('GET', `/api/projects/${projectId}/terminals`)).body;
    const empty = await plist();
    check('a project has no terminals until one is opened', empty.available && empty.terminals.length === 0, JSON.stringify(empty));
    const made = await send<{ id: string }>('POST', `/api/projects/${projectId}/terminals`, { cols: 100, rows: 30 });
    const pt = made.body.id;
    check('POST /api/projects/:id/terminals → 201 with an id', made.status === 201 && /^term_/.test(pt), JSON.stringify(made));
    const listed = await plist();
    const pinfo = listed.terminals[0];
    check("it is listed as the project's, in the project folder, with the shell it runs", listed.terminals.length === 1 && pinfo?.id === pt && pinfo.scope.kind === 'project' && pinfo.scope.projectId === projectId && pinfo.cwd === ROOT && pinfo.shell === '/bin/sh', JSON.stringify(listed));
    check("and not as any agent's", !(await list('agt_t')).terminals.some((t) => t.id === pt));
    const agentSide = (await open('agt_t')).body.id;
    check("an agent's is listed with the agent's scope, not in the project's list", (await list('agt_t')).terminals.find((t) => t.id === agentSide)?.scope.kind === 'agent' && !(await plist()).terminals.some((t) => t.id === agentSide));
    const pg = attach(pt);
    await pg.opened;
    pg.type('pwd -P\n');
    check('its shell starts in the project folder', (await pg.waitFor(new RegExp(`\\r\\n${ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r\\n`))) !== null, pg.text().slice(-200));
    pg.close();
    await pg.closed;
    check('the hub said so: a `terminals` frame for the project, listing it', await until(() => termFrames(pkey).some((f) => f.terminals.some((t) => t.id === pt))), JSON.stringify(termFrames(pkey)));
    check("and one for the agent's, apart", await until(() => termFrames('agent:agt_t').some((f) => f.terminals.some((t) => t.id === agentSide))));
    check('the frame never carries output', termFrames(pkey).every((f) => Object.keys(f).sort().join() === 'scope,terminals,type'));
    const before = termFrames(pkey).length;
    check('DELETE closes it', (await send('DELETE', `/api/terminals/${pt}`)).status === 200 && (await plist()).terminals.length === 0);
    check('and the hub says the list is empty now', await until(() => termFrames(pkey).length > before && termFrames(pkey).at(-1)!.terminals.length === 0), JSON.stringify(termFrames(pkey).at(-1)));
    const ex2 = (await send<{ id: string }>('POST', `/api/projects/${projectId}/terminals`, {})).body.id;
    const pe = attach(ex2);
    await pe.opened;
    pe.type('exit 4\n');
    await pe.closed;
    check('a shell exiting is a frame too: listed as exited, with its code', await until(() => termFrames(pkey).at(-1)?.terminals.find((t) => t.id === ex2)?.exitCode === 4), JSON.stringify(termFrames(pkey).at(-1)));
    await send('DELETE', `/api/terminals/${ex2}`);
    await send('DELETE', `/api/terminals/${agentSide}`);
    check('GET and POST for an unknown project → 404', (await send('GET', '/api/projects/prj_nope/terminals')).status === 404 && (await send('POST', '/api/projects/prj_nope/terminals', {})).status === 404);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n11c · the terminal settings (141)');
  {
    const patch = (k: string, v: string | null) => send<{ error?: string; detail?: string }>('PATCH', '/api/settings', { settings: { [k]: v } });
    for (const [k, bad, good] of [
      ['conductor.terminal.fontSize', ['8', '25', '13.5', 'big', ''], ['9', '24', '15']],
      ['conductor.terminal.scrollback', ['999', '100001', '5e3', 'x'], ['1000', '100000', '20000']],
    ] as const) {
      const refused = await Promise.all(bad.map((v) => patch(k, v)));
      check(`${k} refuses ${bad.map((v) => JSON.stringify(v)).join(', ')}, with the range`, refused.every((r) => r.status === 400 && /a whole number from/.test(r.body.detail ?? '')), JSON.stringify(refused.map((r) => r.body)));
      const taken = await Promise.all(good.map((v) => patch(k, v)));
      check(`and takes ${good.join(', ')}`, taken.every((r) => r.status === 200));
      await patch(k, null);
    }
    const sh = (await send<TermShellsResponse>('GET', '/api/terminals/shells')).body;
    check('GET /api/terminals/shells lists the shells here, and $SHELL as the default', sh.default === '/bin/sh' && sh.shells.some((s) => s.path === '/bin/sh') && sh.shells.every((s) => s.path.startsWith('/') && s.label.length > 0), JSON.stringify(sh));
    const noShell = await patch('conductor.terminal.shell', '/bin/no-such-shell');
    check('a shell that is not one of them is refused, naming the ones that are', noShell.status === 400 && /not a shell on this machine/.test(noShell.body.detail ?? ''), JSON.stringify(noShell.body));
    const other = sh.shells.find((s) => s.path === '/bin/bash') ?? sh.shells.find((s) => s.path !== '/bin/sh');
    if (other) {
      check(`one that is is taken (${other.path})`, (await patch('conductor.terminal.shell', other.path)).status === 200);
      const oid = (await open('agt_t')).body.id;
      check('and is what a new terminal runs', mgr.get(oid)?.shell === other.path, JSON.stringify(mgr.get(oid)));
      await send('DELETE', `/api/terminals/${oid}`);
      await patch('conductor.terminal.shell', null);
    }
    check('with the setting removed, the default again', (() => mgr.get((mgr.create({ scope: { kind: 'project', projectId }, cwd: ROOT })).id)?.shell === '/bin/sh')());
    await mgr.shutdown();

    // The scrollback setting is the mirror's too: a page reattaching gets that many lines above the screen.
    await patch('conductor.terminal.scrollback', '1000');
    const sb = (await send<{ id: string }>('POST', `/api/projects/${projectId}/terminals`, { cols: 80, rows: 24 })).body.id;
    const s1 = attach(sb);
    await s1.opened;
    s1.type("seq 1 3000; echo SEQ-%s | sed 's/%s/DONE/'\n");
    check('it ran', (await s1.waitFor(/SEQ-DONE/, 10_000)) !== null);
    s1.close();
    await s1.closed;
    const s2 = attach(sb);
    await s2.opened;
    await until(() => /SEQ-DONE/.test(s2.text()), 5_000);
    const kept = await drawn(Buffer.concat(s2.chunks), 80, 24);
    check('with scrollback 1000, a page reattaching gets the last 1,000 lines and the screen, no more', kept.all.length <= 1000 + 24 && kept.all.includes('2500') && !kept.all.includes('1500'), `${kept.all.length} lines`);
    s2.close();
    await s2.closed;
    await send('DELETE', `/api/terminals/${sb}`);
    await patch('conductor.terminal.scrollback', null);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n12 · removing an agent, a job or a project ends its shells');
  const aT = (await open('agt_t')).body.id;
  const aU = (await open('agt_u')).body.id;
  const aU2 = (await open('agt_u2')).body.id;
  const aP = (await send<{ id: string }>('POST', `/api/projects/${projectId}/terminals`, {})).body.id;
  const pid = async (termId: string): Promise<number> => {
    const pg = attach(termId);
    await pg.opened;
    pg.type('echo P=$$\n');
    const m = await pg.waitFor(/P=(\d+)/);
    pg.close();
    return Number(m?.[1]);
  };
  const [pidT, pidU, pidU2, pidP] = [await pid(aT), await pid(aU), await pid(aU2), await pid(aP)];
  check('four shells, four processes', mgr.live === 4 && [pidT, pidU, pidU2, pidP].every((p) => p > 0 && alive(p)), `${pidT} ${pidU} ${pidU2} ${pidP}`);
  const rmAgent = await send('DELETE', '/api/agents/agt_u');
  check('removing an agent → 200', rmAgent.status === 200, JSON.stringify(rmAgent.body));
  check('its shell ends', await until(() => !alive(pidU), 4_000));
  check("and it is no longer listed; its job-mate's and the other agent's are", mgr.get(aU) === null && mgr.get(aU2) !== null && mgr.get(aT) !== null && alive(pidU2) && alive(pidT));
  const rmJob = await send('DELETE', '/api/jobs/job_u');
  check('removing a job → 200', rmJob.status === 200, JSON.stringify(rmJob.body));
  check("its remaining agent's shell ends", await until(() => !alive(pidU2), 4_000) && mgr.get(aU2) === null);
  check("and the other job's does not, nor the project's", alive(pidT) && mgr.get(aT) !== null && alive(pidP) && mgr.get(aP) !== null);
  const rmProject = await send('DELETE', `/api/projects/${projectId}`);
  check('removing the project → 200', rmProject.status === 200, JSON.stringify(rmProject.body));
  check("the agent's last shell ends, and the project's own (141)", (await until(() => !alive(pidT) && !alive(pidP), 4_000)) && mgr.get(aT) === null && mgr.get(aP) === null && mgr.live === 0);
  check('and the hub says the project has none', await until(() => termFrames(pkey).at(-1)?.terminals.length === 0));
  feed.close();

  // ───────────────────────────────────────────────────────────────────────────
  console.log('\n13 · a page that cannot keep up pauses the shell');
  // The manager directly, with a viewer whose queue is as long as we say. `yes` never stops
  // on its own: whatever is received is what the shell was allowed to write.
  const slowJob = join(ROOT, 'slow');
  mkdirSync(slowJob, { recursive: true });
  const slow = mgr.create({ scope: { kind: 'agent', agentId: 'agt_slow' }, jobId: 'job_slow', cwd: slowJob });
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
      ? `\nAmendment 112 + 141 terminal: PASS — ${checks} checks: a real shell echoes, resizes and replays the screen (full-screen included, the raw 512 KB without the mirror); a project's terminals open, list, close and broadcast; the settings hold; DELETE, an agent, a job, a project and the daemon's stop each end it; 16 is the most; an unknown id is 404; a foreign Origin is refused on the socket.\n`
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
