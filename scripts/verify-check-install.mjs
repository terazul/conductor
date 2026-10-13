#!/usr/bin/env node
// Verify Amendment 134: `make start` says when the install is out of date, and starts nothing.
//
//   node scripts/verify-check-install.mjs
//
// Temp checkouts under os.tmpdir(), each with a pnpm-lock.yaml and (or not) pnpm's copy of it in
// node_modules/.pnpm/lock.yaml. The pure comparison is checked directly; the CLI is run as `make
// start` runs it, with --root pointing at a temp checkout and a fake `pnpm` first on the PATH that
// leaves a mark when it is run, so "starts nothing" is checked rather than assumed.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installState, STALE_LINE, REPO_ROOT } from './check-install.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'check-install.mjs');
const LOCK = "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n";

const scratch = mkdtempSync(join(tmpdir(), 'conductor-check-install-'));
let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A checkout with a lock and, unless copy is null, pnpm's copy of it. */
function checkout(name, { lock = LOCK, copy = LOCK } = {}) {
  const root = join(scratch, name);
  mkdirSync(root, { recursive: true });
  if (lock !== null) writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
  if (copy !== null) {
    mkdirSync(join(root, 'node_modules', '.pnpm'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.pnpm', 'lock.yaml'), copy);
  }
  return root;
}

// A fake pnpm: records that it ran (and with what) in its own directory, and exits with $FAKE_PNPM_EXIT.
const bin = join(scratch, 'bin');
mkdirSync(bin);
const mark = join(bin, 'pnpm-ran');
writeFileSync(
  join(bin, 'pnpm'),
  `#!/bin/sh\necho "$PWD $*" > '${mark}'\nexit "\${FAKE_PNPM_EXIT:-0}"\n`,
);
chmodSync(join(bin, 'pnpm'), 0o755);

function cli(root, env = {}, cwd = scratch) {
  rmSync(mark, { force: true });
  const childEnv = { ...process.env, PATH: bin + delimiter + process.env.PATH, ...env };
  if (!('CONDUCTOR_AUTO_INSTALL' in env)) delete childEnv.CONDUCTOR_AUTO_INSTALL;
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root], { cwd, env: childEnv, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ran: existsSync(mark) ? readFileSync(mark, 'utf8').trim() : null };
}

try {
  console.log('installState');
  const current = checkout('current');
  const stale = checkout('stale', { copy: LOCK + "  packages/web: {}\n" });
  const noModules = checkout('no-node-modules', { copy: null });
  const noCopy = checkout('no-copy', { copy: null });
  mkdirSync(join(noCopy, 'node_modules'), { recursive: true });
  const crlf = checkout('crlf', { copy: LOCK.replace(/\n/g, '\r\n') });
  check('identical lock and copy → current', installState(current) === 'current', installState(current));
  check('different copy → stale', installState(stale) === 'stale', installState(stale));
  check('no node_modules → missing', installState(noModules) === 'missing', installState(noModules));
  check('node_modules without .pnpm/lock.yaml → missing', installState(noCopy) === 'missing', installState(noCopy));
  check('byte for byte: line endings alone make it stale', installState(crlf) === 'stale', installState(crlf));

  console.log('the CLI, as make start runs it');
  const ok = cli(current);
  check('current: exits 0', ok.status === 0, `exit ${ok.status}`);
  check('current: says nothing', ok.stdout === '' && ok.stderr === '', JSON.stringify(ok.stderr));
  check('current: runs no pnpm', ok.ran === null, ok.ran);

  const bad = cli(stale);
  check('stale: exits 1', bad.status === 1, `exit ${bad.status}`);
  check('stale: one sentence on stderr', bad.stderr === STALE_LINE + '\n', JSON.stringify(bad.stderr));
  check(
    'stale: the sentence is the one in the manual',
    STALE_LINE === 'Dependencies are out of date: run `make install` (or `pnpm install`), then start again.',
  );
  check('stale: nothing on stdout', bad.stdout === '', JSON.stringify(bad.stdout));
  check('stale: starts nothing (no pnpm run)', bad.ran === null, bad.ran);

  const none = cli(noModules);
  check('no node_modules: exits 1 with the sentence', none.status === 1 && none.stderr === STALE_LINE + '\n', `exit ${none.status} ${JSON.stringify(none.stderr)}`);
  check('no node_modules: starts nothing', none.ran === null, none.ran);

  const notOne = cli(stale, { CONDUCTOR_AUTO_INSTALL: 'yes' });
  check('CONDUCTOR_AUTO_INSTALL other than 1: still only the sentence', notOne.status === 1 && notOne.ran === null, `exit ${notOne.status} ran ${notOne.ran}`);

  console.log('CONDUCTOR_AUTO_INSTALL=1');
  const auto = cli(stale, { CONDUCTOR_AUTO_INSTALL: '1' });
  check('stale: runs pnpm install --frozen-lockfile --prefer-offline', auto.ran?.endsWith('install --frozen-lockfile --prefer-offline') === true, auto.ran);
  check('stale: runs it in the checkout, not the cwd', auto.ran?.startsWith(realpathSync(stale) + ' ') === true, auto.ran);
  check('stale: exits with pnpm\'s code (0)', auto.status === 0, `exit ${auto.status}`);
  check('stale: no sentence when it installs', !auto.stderr.includes(STALE_LINE), JSON.stringify(auto.stderr));
  const autoFail = cli(stale, { CONDUCTOR_AUTO_INSTALL: '1', FAKE_PNPM_EXIT: '7' });
  check('stale: exits with pnpm\'s code (7)', autoFail.status === 7, `exit ${autoFail.status}`);
  const autoOk = cli(current, { CONDUCTOR_AUTO_INSTALL: '1' });
  check('current: installs nothing even with auto-install on', autoOk.status === 0 && autoOk.ran === null, `exit ${autoOk.status} ran ${autoOk.ran}`);

  console.log('paths');
  const elsewhere = spawnSync(process.execPath, [SCRIPT, '--root'], { cwd: scratch, encoding: 'utf8' });
  check('--root with no directory: exits 2', elsewhere.status === 2, `exit ${elsewhere.status}`);
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH };
  delete env.CONDUCTOR_AUTO_INSTALL;
  const fromCwd = spawnSync(process.execPath, [SCRIPT], { cwd: tmpdir(), env, encoding: 'utf8' });
  const want = installState(REPO_ROOT) === 'current' ? 0 : 1;
  check('no --root: checks the repo the script is in, whatever the cwd', fromCwd.status === want, `exit ${fromCwd.status}, repo is ${installState(REPO_ROOT)}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const total = passed + failed;
if (failed === 0) {
  console.log(`\nAmendment 134 install check: PASS — ${total} checks`);
} else {
  console.log(`\nAmendment 134 install check: FAIL — ${failed} of ${total} checks failed`);
  process.exit(1);
}
