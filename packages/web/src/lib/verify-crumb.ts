/**
 * Validator checks for Amendment 107 (one "where you are" label, the same on every
 * screen).
 *
 * Design: ADR 0006 (docs/adr/0006-one-crumb-everywhere.md), § Testing. Source-only: no
 * daemon, no browser. It reads the CSS and the screens' source the way `lib/verify.ts`'s
 * own source-regex sections do, but lives on its own so this amendment's checks don't
 * have to land inside a file another lane also edits.
 *
 * Run: pnpm --filter @conductor/web exec tsx src/lib/verify-crumb.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const src = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

console.log('\nA · one shared crumb, on `--here`, in shell/ui.css');
{
  const ui = src('../shell/ui.css');
  // Amendment 127: the backdrop is `--crumb`, which is `--here` unless the screen has its own.
  check(
    '.ui-crumb exists with background: var(--crumb), and --crumb is var(--here) by default',
    /\.ui-crumb\s*\{[^}]*--crumb:\s*var\(--here\)\s*;[^}]*background:\s*var\(--crumb\)[^}]*\}/.test(ui),
  );
}

console.log('\nB · the four per-screen copies are gone, not just unused');
{
  const root = new URL('../', import.meta.url);
  const offenders: string[] = [];
  const walk = (dir: URL): void => {
    for (const name of readdirSync(dir)) {
      const url = new URL(name, dir);
      if (statSync(url).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.css$/.test(name)) {
        const css = readFileSync(url, 'utf8');
        for (const cls of ['.fl-crumb', '.atn-crumb', '.pv-crumb']) {
          if (css.includes(cls)) offenders.push(`${cls} in ${url.pathname.split('/src/')[1] ?? name}`);
        }
      }
    }
  };
  walk(root);
  check('no CSS file under src/ still defines .fl-crumb, .atn-crumb or .pv-crumb', offenders.length === 0, offenders.join(', '));
}

console.log('\nC · the Files crumb keeps only what a path needs — the backdrop comes from one place');
{
  const files = src('../files/files.css');
  const blocks = files.match(/\.c5-crumb[^{]*\{[^}]*\}/g) ?? [];
  check('.c5-crumb has at least one rule left (overflow/ellipsis)', blocks.length > 0);
  check('.c5-crumb has no background of its own', blocks.every((b) => !/background/.test(b)), blocks.join(' | '));
  check('.c5-crumb i still has its tighter 5px margin', /\.c5-crumb i\s*\{[^}]*margin:\s*0 5px[^}]*\}/.test(files));
}

console.log('\nD · every crumb in the markup carries the shared class');
{
  const files: Array<[string, string]> = [
    ['../fleet/fleet.tsx', 'fleet/fleet.tsx'],
    ['../fleet/project.tsx', 'fleet/project.tsx'],
    ['../agent/agent.tsx', 'agent/agent.tsx'],
    ['../attention/route.tsx', 'attention/route.tsx'],
    ['../preview/route.tsx', 'preview/route.tsx'],
    ['../files/route.tsx', 'files/route.tsx'],
    ['../files/FilePane.tsx', 'files/FilePane.tsx'],
  ];
  let total = 0;
  const offenders: string[] = [];
  for (const [path, label] of files) {
    const code = src(path);
    const matches = code.match(/className="[^"]*crumb[^"]*"/g) ?? [];
    for (const m of matches) {
      total++;
      if (!/\bui-crumb\b/.test(m)) offenders.push(`${label}: ${m}`);
    }
  }
  check('at least the twelve known crumb sites were found', total >= 12, String(total));
  check('every className="…crumb…" includes ui-crumb', offenders.length === 0, offenders.join(', '));
}

console.log('\nE · the Agent crumb-as-button keeps ag-crumb alongside the shared class');
{
  const agent = src('../agent/agent.tsx');
  check('agent.tsx has "ui-crumb ag-crumb is-agent"', /className="ui-crumb ag-crumb is-agent"/.test(agent));
}

console.log('\nF · the Project and Agent screens have their own backdrop, Needs You\'s project / role label shares Agent\'s (Amendment 135); every other screen stays on `--here` (Amendment 127)');
{
  const ui = src('../shell/ui.css');
  check(
    'the border is still mixed 60% from the backdrop and 40% --ink3, as Amendment 97 had it',
    /\.ui-crumb\s*\{[^}]*border:\s*1px solid color-mix\(in srgb, var\(--crumb\) 60%, var\(--ink3\)\)[^}]*\}/.test(ui),
  );
  const rule = (cls: string): string => ui.match(new RegExp(`\\.ui-crumb\\.${cls}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  check('.ui-crumb.is-project sets --crumb to --here-project', /--crumb:\s*var\(--here-project\)\s*;/.test(rule('is-project')), rule('is-project'));
  check('.ui-crumb.is-agent sets --crumb to --here-agent', /--crumb:\s*var\(--here-agent\)\s*;/.test(rule('is-agent')), rule('is-agent'));
  check(
    'and they set nothing else, so the agent button\'s hover border (agent.css) is not outranked',
    rule('is-project').trim().split(';').filter(Boolean).length === 1 && rule('is-agent').trim().split(';').filter(Boolean).length === 1,
  );
  check('the hover border on the agent button is still there', /\.ag-crumb:hover\s*\{[^}]*border-color:/.test(src('../agent/agent.css')));

  const crumbs = (path: string): string[] => src(path).match(/className="[^"]*crumb[^"]*"/g) ?? [];
  check('Project\'s label is "ui-crumb is-project"', crumbs('../fleet/project.tsx').join('|') === 'className="ui-crumb is-project"', crumbs('../fleet/project.tsx').join('|'));
  check('Agent\'s label is "ui-crumb ag-crumb is-agent"', crumbs('../agent/agent.tsx').join('|') === 'className="ui-crumb ag-crumb is-agent"', crumbs('../agent/agent.tsx').join('|'));
  // Needs You's `project / role` header names the agent whose request is in focus, so it wears the
  // Agent screen's backdrop (Amendment 135); its `needs you / …` headers name the screen, and stay.
  const needs = src('../attention/route.tsx');
  const needsAgent = needs.match(/<span className="([^"]*)">\s*\{focused\.projectName\}/)?.[1] ?? '';
  check('Needs You\'s project / role label is "ui-crumb is-agent"', needsAgent === 'ui-crumb is-agent', needsAgent);
  const needsRest = crumbs('../attention/route.tsx').filter((c) => c !== 'className="ui-crumb is-agent"');
  check(
    'Needs You has one is-agent label, and its two "needs you / …" labels keep --here',
    crumbs('../attention/route.tsx').length === 3 && needsRest.length === 2 && needsRest.every((c) => c === 'className="ui-crumb"'),
    crumbs('../attention/route.tsx').join('|'),
  );
  const others = ['../fleet/fleet.tsx', '../preview/route.tsx', '../files/route.tsx', '../files/FilePane.tsx', '../branches/route.tsx'];
  const strays = others.filter((p) => /\bis-(project|agent)\b/.test(crumbs(p).join(' ')));
  check('Fleet, Preview, Files and Branches keep --here', strays.length === 0, strays.join(', '));
}

console.log(failures === 0 ? '\ncrumb verify: PASS\n' : `\ncrumb verify: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
