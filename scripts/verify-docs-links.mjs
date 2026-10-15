#!/usr/bin/env node
// Verify Amendment 153: every relative `.md` link in the docs points to a file git tracks.
//
//   node scripts/verify-docs-links.mjs
//
// Reads README.md, docs/MANUAL.md, TODO.md and every tracked .md under docs/. A link is
// `[text](target)` or a reference definition `[label]: target`. http(s), mailto and pure
// `#anchor` links are skipped, and so is anything inside a fenced code block or an inline code
// span. The `#fragment` is stripped, the rest is resolved against the linking file's folder (or
// the repo root for a leading `/`), and must be in `git ls-files`. Links to anything other than a
// .md file are not checked.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
if (ls.status !== 0) {
  console.log(`docs links: FAIL — git ls-files exited ${ls.status}: ${ls.stderr.trim()}`);
  process.exit(1);
}
const tracked = new Set(ls.stdout.split('\0').filter(Boolean));

const sources = [...tracked]
  .filter((f) => f === 'README.md' || f === 'TODO.md' || f === 'docs/MANUAL.md' || (f.startsWith('docs/') && f.endsWith('.md')))
  .sort();

const INLINE = /\[(?:[^\[\]]|\[[^\]]*\])*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;

/** The link targets on one line of prose, with inline code spans taken out first. */
function targets(line) {
  const prose = line.replace(/(`+)[\s\S]*?\1/g, (m) => ' '.repeat(m.length));
  const found = [...prose.matchAll(INLINE)].map((m) => m[1]);
  const def = DEFINITION.exec(prose);
  if (def) found.push(def[1]);
  return found.map((t) => (t.startsWith('<') ? t.slice(1, -1) : t));
}

let links = 0;
const bad = [];

for (const file of sources) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  let fence = null;
  lines.forEach((line, i) => {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      // A fence closes on a bare run of its own character, at least as long as the opening one.
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return;
    }
    if (open) {
      fence = open[1];
      return;
    }
    for (const target of targets(line)) {
      if (/^(https?:|mailto:)/i.test(target) || target.startsWith('#')) continue;
      const path = target.replace(/[#?].*$/, '');
      if (!path.toLowerCase().endsWith('.md')) continue;
      links++;
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch {}
      const resolved = decoded.startsWith('/') ? posix.normalize(decoded.slice(1)) : posix.join(posix.dirname(file), decoded);
      if (!tracked.has(resolved)) bad.push(`${file}:${i + 1} → ${target}`);
    }
  });
}

if (bad.length === 0) {
  console.log(`docs links: PASS — ${links} links in ${sources.length} files`);
} else {
  for (const b of bad) console.log(`  ✗ ${b}`);
  console.log(`\ndocs links: FAIL — ${bad.length} of ${links} links point to no file in git`);
  process.exit(1);
}
