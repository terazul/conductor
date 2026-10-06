/**
 * W0 smoke test — the I1 gate, automated.
 *
 * W0 OWNS THIS FILE.
 *   pnpm --filter @conductor/daemon smoke
 *
 * Proves the chain every track depends on:
 *   1. daemon boots, migrations apply, routes auto-register
 *   2. a WS client subscribing at since=0 gets `hello` + a snapshot
 *   3. appended events reach that client, coalesced, in seq order
 *   4. a client reconnecting with a cursor gets ONLY the gap (lossless replay),
 *      then the whole-list frames, which the log does not carry
 *   5. snapshot contributors compose without a shared function
 *
 * If this fails, no track's work can be trusted. Run it before every merge.
 */

import { request as httpRequest } from 'node:http';
import { build } from './index.js';
import { refuseNonLocal } from './guard.js';
import { dbPath } from './db/index.js';
import { allowHome, conductorHome, declineHome, decideAtBoot, resetStorageForTest, saveMemoryHome } from './storage.js';
import { forgetSettings, patchSettings, readSettings } from './settings.js';
import { askFirst } from './setup.js';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventLog } from './eventlog.js';
import { registerSnapshotContributor } from './hub.js';
import type { Alert, Job, ServerFrame } from '@conductor/shared';

const PORT = 7799;
const SETUP_PORT = 7798;
let failures = 0;

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Collects frames from one WS connection.
 *
 * `waitIdle()` must hand back a FRESH promise each call — a single shared
 * promise resolves once and every later await returns instantly, which silently
 * makes the assertions pass against zero data.
 */
function connect(since: number): Promise<{
  frames: ServerFrame[];
  close: () => void;
  waitIdle: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const frames: ServerFrame[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);

    let idleTimer: NodeJS.Timeout | null = null;
    let resolveIdle: (() => void) | null = null;

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        resolveIdle?.();
        resolveIdle = null;
      }, 400);
    };

    const waitIdle = () =>
      new Promise<void>((r) => {
        resolveIdle = r;
        armIdle();
      });

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'subscribe', since }));
      resolve({ frames, close: () => socket.close(), waitIdle });
    };
    socket.onmessage = (ev) => {
      frames.push(JSON.parse(String(ev.data)) as ServerFrame);
      armIdle();
    };
    socket.onerror = () => reject(new Error('ws error'));
  });
}

const scope = { projectId: 'prj_smoke', jobId: 'job_smoke', agentId: 'agt_smoke' };

async function main(): Promise<void> {
  process.env['CONDUCTOR_DB'] = `/tmp/conductor-smoke-${Date.now()}.db`;
  process.env['CONDUCTOR_PORT'] = String(PORT);
  process.env['LOG_LEVEL'] = 'silent';

  const app = await build();
  await app.listen({ host: '127.0.0.1', port: PORT });

  // 5. contributors compose — Track A/C/D register theirs the same way.
  registerSnapshotContributor(() => ({ slots: { used: 3, total: 7 } }));
  registerSnapshotContributor(() => ({ costToday: 1.25 }));

  // Amendment 2 regression: two contributors supplying the SAME array slice must
  // accumulate, not clobber. The original shallow spread silently dropped one,
  // last-registration-wins, with no error — Track C found it.
  const job = (id: string): Job => ({
    id,
    projectId: 'prj_smoke',
    prompt: 'x',
    isolation: 'worktree',
    worktreePath: `/tmp/${id}`,
    branch: 'main',
    status: 'working',
    createdAt: new Date().toISOString(),
    endedAt: null,
    budgetUsd: null,
  });
  registerSnapshotContributor(() => ({ jobs: [job('job_from_a')] }));
  registerSnapshotContributor(() => ({ jobs: [job('job_from_c')] }));

  console.log('\n1 · boot');
  const health = (await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json()) as {
    ok: boolean;
    seq: number;
  };
  check('health responds', health.ok === true);
  check('log starts empty', health.seq === 0, `seq=${health.seq}`);

  console.log('\n2 · subscribe from zero');
  const a = await connect(0);
  await a.waitIdle();
  const hello = a.frames.find((f) => f.type === 'hello');
  check('hello received', hello !== undefined);
  check(
    'scalar contributions applied',
    hello?.type === 'hello' && hello.snapshot.slots.used === 3 && hello.snapshot.costToday === 1.25,
    hello?.type === 'hello' ? JSON.stringify(hello.snapshot.slots) : 'no hello',
  );
  const jobIds =
    hello?.type === 'hello' ? hello.snapshot.jobs.map((j) => j.id).sort() : [];
  check(
    'array contributions COMPOSE, not clobber',
    jobIds.length === 2 && jobIds[0] === 'job_from_a' && jobIds[1] === 'job_from_c',
    `jobs=[${jobIds.join(', ')}] — amendment 2 regression`,
  );

  console.log('\n3 · live delivery');
  const log = eventLog();
  log.emit(scope, { kind: 'status', status: 'working' });
  for (let i = 0; i < 25; i += 1) {
    log.emit(scope, {
      kind: 'tool_start',
      toolUseId: `tu_${i}`,
      tool: 'Read',
      input: { file_path: `f${i}.ts` },
      label: `Read f${i}.ts`,
    });
  }
  const afterBurst = log.head();
  await a.waitIdle();

  const delivered = a.frames
    .filter((f): f is Extract<ServerFrame, { type: 'events' }> => f.type === 'events')
    .flatMap((f) => f.events);
  check('all 26 events delivered', delivered.length === 26, `got ${delivered.length}`);
  check(
    'seq strictly ascending',
    delivered.every((e, i) => i === 0 || e.seq > delivered[i - 1]!.seq),
  );
  check(
    'coalesced into fewer frames than events',
    a.frames.filter((f) => f.type === 'events').length < 26,
    `${a.frames.filter((f) => f.type === 'events').length} frames for 26 events`,
  );
  a.close();

  console.log('\n4 · lossless reconnect');
  const cursor = delivered.at(-1)!.seq;
  // A list that changed while the client was away, as an alert does when the daemon
  // restarts and forgets an outage. It isn't in the log, so the gap can't carry it.
  let away: Alert[] = [
    {
      id: 'failed:agt_smoke:1',
      kind: 'failed',
      cause: 'api_error',
      projectId: scope.projectId,
      jobId: scope.jobId,
      agentIds: [scope.agentId],
      since: new Date().toISOString(),
    },
  ];
  registerSnapshotContributor(() => ({ alerts: away }));
  log.emit(scope, { kind: 'text', text: 'emitted while the client was away' });
  log.emit(scope, { kind: 'usage', costUsd: 0.4, inputTokens: 100, outputTokens: 20 });

  const b = await connect(cursor);
  await b.waitIdle();
  const replayed = b.frames
    .filter((f): f is Extract<ServerFrame, { type: 'events' }> => f.type === 'events')
    .flatMap((f) => f.events);
  check('replayed only the gap', replayed.length === 2, `got ${replayed.length}`);
  check('no snapshot resent on reconnect', !b.frames.some((f) => f.type === 'hello'));
  check(
    'gap contents correct',
    replayed[0]?.payload.kind === 'text' && replayed[1]?.payload.kind === 'usage',
  );
  check('head advanced past burst', log.head() === afterBurst + 2);
  const lists = b.frames.filter((f) => f.type === 'alerts' || f.type === 'pending' || f.type === 'servers');
  const last = lists.at(-1);
  check(
    'reconnect resends the lists the log does not carry',
    lists.map((f) => f.type).join(' ') === 'pending servers alerts' &&
      last?.type === 'alerts' &&
      last.alerts[0]?.id === 'failed:agt_smoke:1',
    lists.map((f) => f.type).join(' ') || 'none',
  );
  b.close();
  away = [];

  console.log('\n5 · derived helpers');
  const events = log.forAgent(scope.agentId);
  check('forAgent returns chronological', events.length === 28 && events[0]!.seq < events[1]!.seq);

  console.log('\n6 · the database is where the user allowed, and nowhere until then (Amendment 46)');
  {
    const was = process.env['CONDUCTOR_DB'];
    const wasHome = process.env['CONDUCTOR_DATA'];
    const base = mkdtempSync(join(tmpdir(), 'conductor-home-'));
    // A setup server that never closes would hang the suite; three seconds, then a ✗.
    const settles = (p: Promise<void>): Promise<boolean> =>
      Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
    const q = (url: string, init?: RequestInit) => fetch(`http://127.0.0.1:${SETUP_PORT}${url}`, init);
    const answer = (allow: unknown) =>
      q('/api/storage/choice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allow }) });

    delete process.env['CONDUCTOR_DB'];
    const home = join(base, 'yes', '.conductor');
    process.env['CONDUCTOR_DATA'] = home;
    resetStorageForTest();
    check('a first start is undecided', decideAtBoot() === 'undecided');
    check('and runs on nothing while it is', dbPath() === ':memory:', dbPath());
    check('and has written nothing under home', !existsSync(home));

    const asking = askFirst('127.0.0.1', SETUP_PORT);
    await new Promise((r) => setTimeout(r, 150));
    const health = (await (await q('/api/health')).json()) as { setup?: boolean };
    check('the setup server answers health, so make start sees it up', health.setup === true);
    check('and refuses the rest with 503', (await q('/api/snapshot')).status === 503);
    check('an answer that is not yes or no → 400', (await answer('yes')).status === 400);
    check('still nothing under home', !existsSync(home));
    const yes = (await (await answer(true)).json()) as { mode: string; db: string };
    check('the setup server closes once it has its answer', await settles(asking));
    check('yes creates the folder, and only then', yes.mode === 'home' && existsSync(home), JSON.stringify(yes));
    check('only the user can read it', (statSync(home).mode & 0o777) === 0o700, (statSync(home).mode & 0o777).toString(8));
    check('the database goes in it', dbPath() === join(home, 'conductor.db'), dbPath());
    resetStorageForTest();
    check('the next start finds the folder and does not ask again', decideAtBoot() === 'home');
    const cwd = process.cwd();
    process.chdir(tmpdir());
    check('and the working directory does not move it', dbPath() === join(home, 'conductor.db'), dbPath());
    process.chdir(cwd);

    // Settings (Amendment 46): kept in the folder once it is allowed.
    forgetSettings();
    const set1 = patchSettings({ 'conductor.theme': 'light', 'conductor.composerH': '300' });
    const sfile = join(home, 'settings.json');
    check('settings are written to settings.json in the folder', existsSync(sfile) && JSON.parse(readFileSync(sfile, 'utf8'))['conductor.theme'] === 'light' && set1['conductor.composerH'] === '300');
    check('readable only by the user', (statSync(sfile).mode & 0o777) === 0o600, (statSync(sfile).mode & 0o777).toString(8));
    let badKey = false;
    try {
      patchSettings({ 'bad key!': 'x', 'conductor.theme': 'dark' });
    } catch {
      badKey = true;
    }
    check('a bad name is refused before anything changes', badKey && readSettings()['conductor.theme'] === 'light');
    let badValue = false;
    try {
      patchSettings({ 'conductor.theme': 3 });
    } catch {
      badValue = true;
    }
    check('so is a value that is not a string', badValue);
    patchSettings({ 'conductor.composerH': null });
    forgetSettings();
    check('null removes one, and a fresh read comes from the file', !('conductor.composerH' in readSettings()) && readSettings()['conductor.theme'] === 'light');
    writeFileSync(sfile, '{ not json');
    forgetSettings();
    check('a broken file is ignored, not fatal', JSON.stringify(readSettings()) === '{}');

    const nohome = join(base, 'no', '.conductor');
    process.env['CONDUCTOR_DATA'] = nohome;
    resetStorageForTest();
    decideAtBoot();
    const asking2 = askFirst('127.0.0.1', SETUP_PORT);
    await new Promise((r) => setTimeout(r, 150));
    const no = (await (await answer(false)).json()) as { mode: string; saved: boolean; db: string };
    check('and closes on a no, too', await settles(asking2));
    check('no runs in memory, says nothing is saved, and writes nothing', no.mode === 'memory' && no.saved === false && no.db === ':memory:' && !existsSync(nohome), JSON.stringify(no));
    resetStorageForTest();
    check('and is not remembered: the next start asks again', decideAtBoot() === 'undecided');
    declineHome();
    forgetSettings();
    patchSettings({ 'conductor.theme': 'dark' });
    check('in memory, settings still work, and nothing is written', readSettings()['conductor.theme'] === 'dark' && !existsSync(nohome));

    const mem = new DatabaseSync(':memory:');
    mem.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('kept')");
    const saved = saveMemoryHome(mem);
    const copy = new DatabaseSync(join(nohome, 'conductor.db'));
    const got = copy.prepare('SELECT x FROM t').get() as { x?: string } | undefined;
    copy.close();
    check('a memory session can be saved home later, for the next start', got?.x === 'kept' && typeof saved.savedAt === 'string');
    let refused = '';
    try {
      saveMemoryHome(mem);
    } catch (err) {
      refused = String(err);
    }
    check("and never over a database that's already there — Conductor refuses, and says why", /won't overwrite/.test(refused), refused);

    // Bringing the old database over (Amendment 53), from a stand-in: never the real one.
    const legacy = join(base, 'old', 'conductor.db');
    mkdirSync(join(base, 'old'), { recursive: true });
    const oldDb = new DatabaseSync(legacy);
    oldDb.exec("PRAGMA journal_mode = WAL; CREATE TABLE projects (id TEXT); CREATE TABLE agents (id TEXT); INSERT INTO projects VALUES ('p1'), ('p2'); INSERT INTO agents VALUES ('a1')");
    // Left open, so the last writes are still in the write-ahead log, as on a real stop.
    const before = { main: readFileSync(legacy), wal: readFileSync(`${legacy}-wal`) };
    process.env['CONDUCTOR_LEGACY_DB'] = legacy;
    const bringHome = join(base, 'bring', '.conductor');
    process.env['CONDUCTOR_DATA'] = bringHome;
    resetStorageForTest();
    decideAtBoot();
    const asked53 = (await (async () => {
      const asking3 = askFirst('127.0.0.1', SETUP_PORT);
      await new Promise((r) => setTimeout(r, 150));
      const got = (await (await q('/api/storage/choice')).json()) as { legacyHolds?: { projects: number; agents: number } };
      const yes3 = (await (await q('/api/storage/choice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allow: true, bring: true }) })).json()) as { broughtFrom?: string; db: string };
      await settles(asking3);
      return { got, yes3 };
    })());
    check('the question says what the old database holds', asked53.got.legacyHolds?.projects === 2 && asked53.got.legacyHolds?.agents === 1, JSON.stringify(asked53.got.legacyHolds));
    const copy53 = new DatabaseSync(join(bringHome, 'conductor.db'), { readOnly: true });
    const count = (t: string) => Number((copy53.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    check('allowed with bring, everything comes over — what was still in the log too', count('projects') === 2 && count('agents') === 1 && asked53.yes3.broughtFrom === legacy);
    copy53.close();
    check('and the old file is left exactly as it was', readFileSync(legacy).equals(before.main) && readFileSync(`${legacy}-wal`).equals(before.wal));
    const plainHome = join(base, 'plain', '.conductor');
    process.env['CONDUCTOR_DATA'] = plainHome;
    resetStorageForTest();
    decideAtBoot();
    allowHome(false);
    check('allowed without bring, it starts empty', !existsSync(join(plainHome, 'conductor.db')));
    oldDb.close();
    delete process.env['CONDUCTOR_LEGACY_DB'];

    // The dock launcher sets CONDUCTOR_HOME to the checkout (Amendment 61): not the data.
    const wasData = process.env['CONDUCTOR_DATA'];
    delete process.env['CONDUCTOR_DATA'];
    process.env['CONDUCTOR_HOME'] = base;
    check("the dock's CONDUCTOR_HOME (the checkout) is not where data goes", conductorHome() === join(homedir(), '.conductor'), conductorHome());
    delete process.env['CONDUCTOR_HOME'];
    if (wasData !== undefined) process.env['CONDUCTOR_DATA'] = wasData;

    process.env['CONDUCTOR_DB'] = 'rel.db';
    resetStorageForTest();
    process.chdir(tmpdir());
    check('CONDUCTOR_DB skips the question', decideAtBoot() === 'override');
    check('and a relative one is made absolute', dbPath() === join(realpathSync(tmpdir()), 'rel.db'), dbPath());
    process.chdir(cwd);

    if (wasHome === undefined) delete process.env['CONDUCTOR_DATA'];
    else process.env['CONDUCTOR_DATA'] = wasHome;
    process.env['CONDUCTOR_DB'] = was;
    resetStorageForTest();
    decideAtBoot();
    forgetSettings();
    rmSync(base, { recursive: true, force: true });

    // Over HTTP, on the running daemon (CONDUCTOR_DB, so settings are in memory).
    const ws = await connect(log.head());
    const patched = await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { 'conductor.theme': 'light' } }),
    });
    check('PATCH /api/settings changes one', patched.status === 200 && ((await patched.json()) as { settings: Record<string, string> }).settings['conductor.theme'] === 'light');
    check('a body without settings → 400', (await fetch(`http://127.0.0.1:${PORT}/api/settings`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 400);
    const snapS = (await (await fetch(`http://127.0.0.1:${PORT}/api/snapshot`)).json()) as { settings?: Record<string, string> };
    check('the snapshot carries them, so a fresh tab starts with them', snapS.settings?.['conductor.theme'] === 'light');
    await new Promise((r) => setTimeout(r, 100));
    check('and every other tab hears the change', ws.frames.some((f) => f.type === 'settings' && f.settings['conductor.theme'] === 'light'));
    ws.close();
  }

  console.log('\n7 · only local pages may talk to the daemon');
  check('rule: localhost with port', refuseNonLocal('localhost:7777', undefined) === null);
  check('rule: ipv6 loopback', refuseNonLocal('[::1]:5173', 'http://[::1]:5173') === null);
  check('rule: rebinding host refused', refuseNonLocal('attacker.example:7777', undefined) === 'host');
  check('rule: missing host refused', refuseNonLocal(undefined, undefined) === 'host');
  check('rule: lookalike host refused', refuseNonLocal('localhost.attacker.example', undefined) === 'host');
  check('rule: foreign origin refused', refuseNonLocal('localhost:7777', 'https://evil.example') === 'origin');
  check('rule: null origin refused', refuseNonLocal('localhost:7777', 'null') === 'origin');
  check('rule: local page allowed', refuseNonLocal('127.0.0.1:7777', 'http://localhost:5173') === null);

  // Over the wire, with a Host that fetch() will not let us forge.
  const status = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: PORT, path: '/api/health', headers });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
  check('http: plain local request allowed', (await status({ host: `127.0.0.1:${PORT}` })) === 200);
  check('http: rebinding host → 403', (await status({ host: `attacker.example:${PORT}` })) === 403);
  check(
    'http: foreign origin → 403',
    (await status({ host: `127.0.0.1:${PORT}`, origin: 'https://evil.example' })) === 403,
  );

  // Node's WebSocket takes headers, so Origin can be set as a browser page would.
  const opens = (origin: string) =>
    new Promise<boolean>((resolve) => {
      const init = { headers: { origin } } as unknown as string[];
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?since=0`, init);
      ws.onopen = () => {
        ws.close();
        resolve(true);
      };
      ws.onerror = () => resolve(false);
    });
  check('ws: local page may subscribe', (await opens('http://localhost:5173')) === true);
  check('ws: foreign origin cannot subscribe', (await opens('https://evil.example')) === false);

  console.log('\n8 · the daemon says which commit it is running (Amendment 38)');
  const built = (await (await fetch(`http://127.0.0.1:${PORT}/api/build`)).json()) as {
    commit: string | null;
    committedAt: string | null;
    startedAt: string;
    head: string | null;
    behind: boolean;
    version: string;
  };
  const here = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  check('the commit is the checkout', built.commit === here, `${built.commit} vs ${here}`);
  check('with the date it was made', built.committedAt !== null && !Number.isNaN(Date.parse(built.committedAt)), String(built.committedAt));
  check('and when the daemon started', Date.parse(built.startedAt) <= Date.now(), built.startedAt);
  check('nothing has moved since boot', built.head === here && built.behind === false, JSON.stringify(built));
  check('the version is the repo root package', built.version === '0.0.0', built.version);

  await app.close();

  console.log(
    failures === 0
      ? '\nW0 smoke: PASS — the contract chain works end to end.\n'
      : `\nW0 smoke: FAIL — ${failures} check(s) failed.\n`,
  );
  finished = true;
  process.exit(failures === 0 ? 0 : 1);
}

/*
 * An awaited promise that never settles empties the event loop, and Node then exits
 * 0 without printing the verdict — a green run that proved nothing. That happened
 * once (a WS socket app.close() waited on); this makes it a failure instead.
 */
let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.error('\nW0 smoke: FAIL — the run never reached its verdict.\n');
    process.exitCode = 1;
  }
});

main().catch((err) => {
  console.error('smoke crashed', err);
  process.exit(1);
});
