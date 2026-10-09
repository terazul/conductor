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
  check(
    '.ui-crumb exists with background: var(--here)',
    /\.ui-crumb\s*\{[^}]*background:\s*var\(--here\)[^}]*\}/.test(ui),
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
  check('agent.tsx:611 is "ui-crumb ag-crumb"', /className="ui-crumb ag-crumb"/.test(agent));
}

console.log(failures === 0 ? '\ncrumb verify: PASS\n' : `\ncrumb verify: FAIL — ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
