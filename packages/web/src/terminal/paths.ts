/**
 * File paths printed in a terminal, as links into Files (Amendment 141; full-terminal.md §5.4).
 *
 * `src/app.ts:12:3`, `./README.md`, `packages/web/src/x.tsx(40,7)` (tsc's form) and an absolute
 * path inside the folder are links; clicking one opens it in Files (5) at that line. A path is
 * taken relative to the terminal's folder, and must stay inside its worktree or project folder:
 * `termFileTarget` resolves it with `files/links.ts`' rules (`resolveDocLink`), which already
 * refuse a path that climbs out with `..`, a `~` path, a backslash and anything with a scheme.
 * A path outside is plain text.
 *
 * To keep ordinary words from becoming links, a match needs a `/` in it or a line number after
 * it: `node.js` is not a link, `README.md:3` and `docs/README.md` are.
 *
 * Pure: no DOM. agent/verify.ts checks it under node; Xterm.tsx maps the matches to cells.
 */

import { resolveDocLink } from '../files/links.js';

export interface PathHit {
  /** Where the match is in the line's text: start, and one past the end. */
  start: number;
  end: number;
  /** The path as printed, without its line and column. */
  path: string;
  line?: number;
  col?: number;
}

/*
 * A path, then `:line`, `:line:col` or `(line,col)`. Not preceded by a path character or `:`,
 * so the middle of a URL (`https://host/x.ts`) or of a longer word is never a match.
 */
const PATH = /(?<![\w./~@:+-])((?:\.{1,2}\/|\/)?(?:[\w.@+-]+\/)*[\w.@+-]+)(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))?/g;

/** The file paths in one line of terminal text. */
export function findPathLinks(text: string): PathHit[] {
  const out: PathHit[] = [];
  for (const m of text.matchAll(PATH)) {
    let path = m[1]!;
    const start = m.index;
    const lineNo = m[2] ?? m[4];
    const colNo = m[3] ?? m[5];
    // A sentence's full stop is not part of the name.
    if (lineNo === undefined) path = path.replace(/\.+$/, '');
    if (path === '' || /^\.+$/.test(path) || /^\/+$/.test(path)) continue;
    const last = path.split('/').pop() ?? '';
    if (last === '' || /^\.+$/.test(last)) continue;
    if (lineNo === undefined && !path.includes('/')) continue;
    // `1.2.3` and `12:30` are versions and times, not files.
    if (/^[\d.]+$/.test(path)) continue;
    const end = lineNo === undefined ? start + path.length : start + m[0].length;
    const hit: PathHit = { start, end, path };
    if (lineNo !== undefined) hit.line = Number(lineNo);
    if (colNo !== undefined) hit.col = Number(colNo);
    out.push(hit);
  }
  return out;
}

/**
 * Where a printed path is in Files: root-relative, or null when it is outside `root` (the
 * worktree or project folder), or not a path at all. `cwd` is the folder the terminal started
 * in, which relative paths are taken from.
 */
export function termFileTarget(raw: string, cwd: string, root: string): string | null {
  const r = root.replace(/\/+$/, '');
  if (r === '' || raw.startsWith('~')) return null;
  let href: string;
  let from: string;
  if (raw.startsWith('/')) {
    // The `/` matters: without it `/wt/job-evil/x` passes as being under `/wt/job` (agent/links.ts:39).
    if (!raw.startsWith(`${r}/`)) return null;
    href = `/${raw.slice(r.length + 1)}`;
    from = '.';
  } else {
    const c = cwd.replace(/\/+$/, '');
    if (c !== r && !c.startsWith(`${r}/`)) return null;
    const dir = c === r ? '' : c.slice(r.length + 1);
    href = raw;
    from = dir ? `${dir}/.` : '.';
  }
  const link = resolveDocLink(href, from);
  return link.kind === 'file' ? link.path : null;
}
