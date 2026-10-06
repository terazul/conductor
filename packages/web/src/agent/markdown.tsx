/**
 * Markdown → React elements, in the browser.  TRACK B.
 *
 * Agents write markdown. An audit report arrives with headings, nested bullets and
 * fenced code, and the transcript used to render it inside a bare `<p>`, where CSS
 * collapses every newline into a space and a structured document becomes one
 * unreadable paragraph. This turns it back into the document it was.
 *
 * WHY THIS IS IN THE BROWSER, when `daemon/src/workspace/markdown.ts` argues against
 * exactly that. Read its reasoning closely: browser rendering would mean "shipping a
 * markdown stack **and a sanitizer** into every tab and trusting each one equally".
 * The sanitizer is the load-bearing half of that sentence, and it is only needed
 * because that renderer produces an HTML *string* for `dangerouslySetInnerHTML`.
 *
 * This one produces React elements. React escapes text children by construction, so
 * `<script>alert(1)</script>` in an agent's output is five words on the screen and
 * cannot be anything else. There is no sanitizer here because there is no HTML here —
 * nothing to configure, nothing to keep in sync, nothing to audit. The moment anyone
 * adds `dangerouslySetInnerHTML` to this file that guarantee is gone and the argument
 * for server-side rendering becomes correct again.
 *
 * It also adds no dependency. `packages/web` ships `react`, `react-dom` and
 * `@conductor/shared`, and CONTRACT §3 says a missing dependency is an escalation, not
 * a manifest edit. `marked` lives in the daemon and stays there.
 *
 * THE ONE INVARIANT: unrecognised syntax renders as LITERAL TEXT, never nothing. This
 * is a deliberately partial markdown — a table, a footnote, an unterminated fence all
 * fall through to text. A renderer that silently swallowed a construct would delete an
 * audit finding, and losing a finding is far worse than showing a stray pipe character.
 *
 * Two omissions worth naming, both to avoid damaging technical prose:
 *
 *  • `_italic_` and `__bold__` are NOT supported. `audit_event_id` contains a pair of
 *    underscores, and every renderer that honours them italicises the middle of
 *    identifiers. Agents write `*` when they mean emphasis.
 *  • Only `http:`/`https:` links become external links. A `javascript:` href is
 *    rendered as text, because a clickable one in a transcript written by a tool-using
 *    model is a script-execution hole with extra steps. The only other href is an
 *    in-app `#files?…` link to a file the job's tree has (F16) — see `fileHref`.
 *
 * It renders one `text` event at a time, so a fence opened in one event and closed in
 * the next is not joined — the unterminated half falls back to literal text, which is
 * the safe direction.
 */

import type { ReactNode } from 'react';
import { isMermaid } from '../lib/mermaid.js';
import { MermaidBlock } from './Mermaid.js';

export function lineCount(text: string): number {
  return text.split('\n').length;
}

// ── inline ──────────────────────────────────────────────────────────────────

/*
 * One pass, ordered alternation. `bold` precedes `italic` so `**x**` is not read as an
 * empty italic; `code` is first so backticks win over everything inside them, which is
 * what stops `` `a ** b` `` from turning into bold.
 */
const INLINE =
  /(?<code>`[^`\n]+`)|(?<bolditalic>\*\*\*[^*]+\*\*\*)|(?<bold>\*\*[^*]+\*\*)|(?<strike>~~[^~]+~~)|(?<italic>\*[^*\n]+\*)|(?<link>\[[^\]\n]+\]\([^)\s]+\))|(?<auto>https?:\/\/[^\s<>()[\]]+)/g;

/** An href we are willing to make clickable, or null to render the text as text. */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Turns a path the agent named into a link to it in the Files screen, or null when it
 * isn't one (agent/links.ts decides). Passed in rather than imported, so the renderer
 * stays pure and knows nothing about jobs or trees.
 */
export type LinkFile = (raw: string) => string | null;

/*
 * The one door a model-written string has into an in-app href, so it only lets an
 * in-app route through: whatever the callback returns, anything but `#…` stays text.
 * The href itself is built by URLSearchParams from a path the job's tree already has,
 * which is what makes it safe to build from model output at all.
 */
function fileHref(linkFile: LinkFile | undefined, raw: string): string | null {
  const href = linkFile?.(raw) ?? null;
  return href !== null && href.startsWith('#') ? href : null;
}

function inline(text: string, keyBase: string, linkFile?: LinkFile): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;

  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    last = at + m[0].length;
    const k = `${keyBase}i${n++}`;
    const g = m.groups ?? {};

    if (g['code'] !== undefined) {
      const body = m[0].slice(1, -1);
      const file = fileHref(linkFile, body);
      out.push(
        file === null ? (
          <code key={k}>{body}</code>
        ) : (
          <a key={k} href={file} className="ag-file">
            <code>{body}</code>
          </a>
        ),
      );
    } else if (g['bolditalic'] !== undefined) {
      out.push(
        <strong key={k}>
          <em>{inline(m[0].slice(3, -3), k, linkFile)}</em>
        </strong>,
      );
    } else if (g['bold'] !== undefined) {
      // What's inside can be formatted too — `**see `x.ts`**` (Amendment 62).
      out.push(<strong key={k}>{inline(m[0].slice(2, -2), k, linkFile)}</strong>);
    } else if (g['strike'] !== undefined) {
      out.push(<del key={k}>{inline(m[0].slice(2, -2), k, linkFile)}</del>);
    } else if (g['italic'] !== undefined) {
      out.push(<em key={k}>{inline(m[0].slice(1, -1), k, linkFile)}</em>);
    } else if (g['link'] !== undefined) {
      const split = m[0].indexOf('](');
      const label = m[0].slice(1, split);
      const url = m[0].slice(split + 2, -1);
      const href = safeHref(url);
      // A relative link is a file in the worktree, or nothing. In-app, so no new tab.
      const file = href === null ? fileHref(linkFile, url) : null;
      // No safe href means the whole `[text](url)` stays as written. The user can
      // still read the URL and decide for themselves; they just cannot click it.
      out.push(
        href !== null ? (
          <a key={k} href={href} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        ) : file !== null ? (
          <a key={k} href={file} className="ag-file">
            {label}
          </a>
        ) : (
          m[0]
        ),
      );
    } else {
      const href = safeHref(m[0]);
      out.push(
        href === null ? (
          m[0]
        ) : (
          <a key={k} href={href} target="_blank" rel="noreferrer noopener">
            {m[0]}
          </a>
        ),
      );
    }
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ── blocks ──────────────────────────────────────────────────────────────────

/*
 * What a model's formatting needs, which this renderer used to drop (Amendment 62):
 * tables, lists nested to any depth and of either kind, numbering that starts where the
 * model started it, task boxes, items that hold paragraphs or code, quotes that hold
 * lists, and fences with an info string or tildes. Still line-based and still only
 * elements — nothing here builds an HTML string — and still: what isn't recognised is
 * text, never nothing.
 */
const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
/** A table's second line: `|---|:--:|` and friends. */
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string): number => (/^\s*/.exec(line)?.[0] ?? '').replace(/\t/g, '    ').length;
const isBlank = (line: string): boolean => line.trim().length === 0;

/** The closing line for a fence that opened with `open` (``` or ~~~, at least as long). */
function closes(open: string, line: string): boolean {
  const t = line.trim();
  return t.length >= open.length && t[0] === open[0] && /^(`+|~+)$/.test(t);
}

/** A table row's cells. `\|` is a pipe inside a cell. */
export function tableCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let j = 0; j < t.length; j++) {
    if (t[j] === '\\' && t[j + 1] === '|') {
      cur += '|';
      j += 1;
    } else if (t[j] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += t[j];
  }
  cells.push(cur.trim());
  return cells;
}

type Align = 'left' | 'center' | 'right' | undefined;
function alignOf(cell: string): Align {
  const c = cell.trim();
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  return l && r ? 'center' : r ? 'right' : l ? 'left' : undefined;
}

/** Whether lines[i] starts a table: a row with a pipe, then a separator with as many columns. */
function startsTable(lines: readonly string[], i: number): boolean {
  const head = lines[i];
  const sep = lines[i + 1];
  if (head === undefined || sep === undefined || !head.includes('|') || !TABLE_SEP.test(sep)) return false;
  return tableCells(sep).length === tableCells(head).length;
}

/** Whether a line opens a block of its own, so it can't be a lazy continuation of a list item. */
function opensBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || startsTable(lines, i);
}

interface ListItem {
  first: string;
  /** Lines under the first one, dedented: paragraphs, code, and lists of their own. */
  body: string[];
  num: number | null;
}

/**
 * One list, starting at lines[i]: its items, and where it ends. An item owns every line
 * indented past its own marker, blank lines between them, and a line that just carries on
 * its first one. A marker of the other kind at the same depth is a new list.
 */
function readList(lines: readonly string[], i: number): { items: ListItem[]; ordered: boolean; next: number } {
  const head = ITEM.exec(lines[i]!)!;
  const ordered = head[3] !== undefined;
  const level = indentOf(head[1] ?? '');
  const items: ListItem[] = [];
  let j = i;
  while (j < lines.length) {
    const m = ITEM.exec(lines[j]!);
    // Deeper items never get here: the item above them owns them.
    if (!m || (m[3] !== undefined) !== ordered) break;
    const item: ListItem = { first: m[4] ?? '', body: [], num: m[3] !== undefined ? Number(m[3]) : null };
    j += 1;
    const owned: string[] = [];
    while (j < lines.length) {
      const line = lines[j]!;
      if (isBlank(line)) {
        // A blank line keeps the item open only if what follows still belongs to it.
        let k = j;
        while (k < lines.length && isBlank(lines[k]!)) k += 1;
        if (k < lines.length && indentOf(lines[k]!) > level) {
          for (; j < k; j++) owned.push('');
          continue;
        }
        break;
      }
      if (indentOf(line) > level) {
        owned.push(line);
        j += 1;
        continue;
      }
      // A line at the item's own depth carries on its text — unless it starts something.
      const prevBlank = owned.length > 0 ? owned.at(-1) === '' : false;
      if (!ITEM.test(line) && !opensBlock(lines, j) && !prevBlank && owned.every((l) => !isBlank(l))) {
        if (owned.length === 0) item.first += `\n${line.trim()}`;
        else owned.push(line);
        j += 1;
        continue;
      }
      break;
    }
    while (owned.length > 0 && owned.at(-1) === '') owned.pop();
    // Indented lines straight after the first, before any blank or new block, carry on
    // its text: `- first line\n  carries on` is one line of prose, not two blocks.
    while (owned.length > 0 && !isBlank(owned[0]!) && !ITEM.test(owned[0]!) && !opensBlock(owned, 0)) {
      item.first += `\n${owned.shift()!.trim()}`;
    }
    const cut = Math.min(...owned.filter((l) => !isBlank(l)).map(indentOf), Number.MAX_SAFE_INTEGER);
    item.body = owned.map((l) => (isBlank(l) ? '' : l.replace(/\t/g, '    ').slice(Math.min(cut, indentOf(l)))));
    items.push(item);
    // Blank lines between items: the list goes on if the next item is one of its own.
    let k = j;
    while (k < lines.length && isBlank(lines[k]!)) k += 1;
    const again = k < lines.length ? ITEM.exec(lines[k]!) : null;
    if (k > j && again && indentOf(again[1] ?? '') <= level && (again[3] !== undefined) === ordered) j = k;
  }
  return { items, ordered, next: j };
}

function listElement(
  list: { items: ListItem[]; ordered: boolean },
  key: string,
  linkFile?: LinkFile,
): ReactNode {
  const body = list.items.map((it, i) => {
    const k = `${key}l${i}`;
    const task = TASK.exec(it.first);
    const text = task ? (task[2] ?? '') : it.first;
    return (
      <li key={k} className={task ? `md-task${task[1] !== ' ' ? ' is-done' : ''}` : undefined}>
        {task && <input type="checkbox" checked={task[1] !== ' '} disabled readOnly aria-label={task[1] !== ' ' ? 'done' : 'not done'} />}
        {inline(text, k, linkFile)}
        {it.body.length > 0 && renderMarkdown(it.body.join('\n'), linkFile, `${k}b`)}
      </li>
    );
  });
  const start = list.items[0]?.num ?? 1;
  return list.ordered ? (
    <ol key={key} {...(start !== 1 ? { start } : {})}>
      {body}
    </ol>
  ) : (
    <ul key={key}>{body}</ul>
  );
}

/**
 * Render markdown to React elements.
 *
 * Line-based, single pass, no backtracking. Anything that does not match a construct
 * becomes paragraph text. `linkFile`, when given, may turn a code span or a relative
 * link that names a file into a link to it (F16); fenced blocks are never linked.
 * `keyBase` keeps keys apart when a list item or a quote renders its own blocks.
 */
export function renderMarkdown(text: string, linkFile?: LinkFile, keyBase = ''): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = (c: string): string => `${keyBase}${c}${n++}`;

  const para: string[] = [];
  const flush = (): void => {
    if (para.length === 0) return;
    const body = para.join('\n');
    para.length = 0;
    const k = key('p');
    out.push(<p key={k}>{inline(body, k, linkFile)}</p>);
  };

  while (i < lines.length) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      // Find the closing fence before committing. Without one this is not a code
      // block, it is a line that happens to start with backticks.
      const open = fence[1]!;
      let end = i + 1;
      while (end < lines.length && !closes(open, lines[end]!)) end += 1;
      if (end < lines.length) {
        flush();
        const lang = fence[2] ?? '';
        const body = lines.slice(i + 1, end).join('\n');
        const k = key('c');
        // A diagram is drawn, in its own component (Amendment 60).
        out.push(
          isMermaid(lang) ? (
            <MermaidBlock key={k} source={body} />
          ) : (
            <pre key={k} className={lang ? `lang-${lang}` : undefined}>
              <code>{body}</code>
            </pre>
          ),
        );
        i = end + 1;
        continue;
      }
      // Unterminated: fall through and let it be text.
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const depth = Math.min(6, heading[1]!.length);
      const H = `h${depth}` as 'h1';
      const k = key('h');
      out.push(<H key={k}>{inline(heading[2] ?? '', k, linkFile)}</H>);
      i += 1;
      continue;
    }

    if (RULE.test(line) && !ITEM.test(line)) {
      flush();
      out.push(<hr key={key('r')} />);
      i += 1;
      continue;
    }

    if (startsTable(lines, i)) {
      flush();
      const head = tableCells(line);
      const aligns = tableCells(lines[i + 1]!).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes('|')) {
        rows.push(tableCells(lines[i]!));
        i += 1;
      }
      const k = key('t');
      // Wrapped, so a wide table scrolls on its own rather than widening the transcript.
      out.push(
        <div key={k} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, ci) => (
                  <th key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                    {inline(c, `${k}h${ci}`, linkFile)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, ci) => (
                    <td key={ci} style={aligns[ci] ? { textAlign: aligns[ci] } : undefined}>
                      {inline(r[ci] ?? '', `${k}r${ri}c${ci}`, linkFile)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (QUOTE.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!);
        if (!q) break;
        quoted.push(q[1] ?? '');
        i += 1;
      }
      const k = key('q');
      // A quote holds blocks too: a list, code, a second paragraph.
      out.push(<blockquote key={k}>{renderMarkdown(quoted.join('\n'), linkFile, `${k}x`)}</blockquote>);
      continue;
    }

    if (ITEM.test(line)) {
      flush();
      const list = readList(lines, i);
      out.push(listElement(list, key('u'), linkFile));
      i = list.next;
      continue;
    }

    if (isBlank(line)) {
      flush();
      i += 1;
      continue;
    }

    para.push(line);
    i += 1;
  }

  flush();
  return out;
}
