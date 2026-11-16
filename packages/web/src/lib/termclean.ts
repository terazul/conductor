/**
 * A terminal selection, cleaned to paste (Amendment 218).
 *
 * What an agent CLI prints is laid out for the screen: its paragraphs are broken at the width
 * of the terminal, indented under a `⏺ `, and padded with spaces. Copied as it is, that pastes
 * as short ragged lines. This puts it back as markdown: wrapped lines joined, the common indent
 * and the `⏺ ` dropped, trailing spaces gone, blank lines kept as paragraph breaks, and list
 * markers kept with how deep each one sits.
 *
 * xterm.js already joins the lines it wrapped itself (`getSelection()`); a CLI that draws its
 * own wraps (Claude Code's does) sends real line ends, so those are joined here by guessing: a
 * line that ran to near the right edge, followed by one at the same indent whose first word
 * would not have fitted, is one line. Widths count characters, so a wide character (CJK, emoji)
 * can make a wrapped line look short and leave it unjoined.
 */

export interface TermSelection {
  /** `getSelection()`: rows joined by line ends, soft wraps already joined. */
  text: string;
  /** The column the selection starts at, so its first line is indented as on the screen. */
  startCol?: number;
  /** The terminal's width; without it only a list item's continuation lines are joined. */
  cols?: number;
}

/** A line that ends this short of the edge may still have wrapped: CLIs keep a margin. */
const SLACK = 6;

const MARKER = /^(?:[-*+•◦]|\d{1,3}[.)])\s+/;
/** Lines that start something of their own, and are never the rest of the line before. */
const OWN_LINE = /^(?:[-*+•◦]\s|\d{1,3}[.)]\s|#{1,6}\s|>|\||```|~~~|[│┃╭╮╰╯├┤┬┴┼└┌┐┘─━═║])/;

interface Line {
  indent: number;
  body: string;
  /** Where the words of this line start: after its marker, for a list item. */
  content: number;
  /** How long the last screen row of it was, to tell whether the next one is its wrap. */
  lastRow: number;
}

const indentOf = (s: string): number => s.length - s.trimStart().length;
const firstWord = (s: string): number => s.trimStart().split(/\s/, 1)[0]?.length ?? 0;

export function cleanTermText({ text, startCol = 0, cols }: TermSelection): string {
  const rows = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((r, i) => (i === 0 ? ' '.repeat(Math.max(0, startCol)) + r : r))
    // The reply marker is where an indent would be, so it goes the same way.
    .map((r) => r.replace(/^(\s*)⏺ /, (_m, sp: string) => `${sp}  `).trimEnd());

  const lines: (Line | null)[] = [];
  let fenced = false;
  for (const row of rows) {
    if (row.trim() === '') {
      lines.push(null);
      continue;
    }
    const indent = indentOf(row);
    const body = row.slice(indent);
    const prev = lines[lines.length - 1];
    const fence = /^(?:```|~~~)/.test(body);
    if (prev && !fenced && !fence && joins(prev, indent, body, cols)) {
      prev.body += ` ${body}`;
      prev.lastRow = row.length;
    } else {
      const marker = MARKER.exec(body);
      lines.push({ indent, body, content: indent + (marker ? marker[0].length : 0), lastRow: row.length });
    }
    if (fence) fenced = !fenced;
  }

  const shared = Math.min(...lines.flatMap((l) => (l ? [l.indent] : [])));
  const out: string[] = [];
  for (const l of lines) {
    if (!l) {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    // A bullet the terminal drew is a markdown one again.
    out.push(' '.repeat(l.indent - shared) + l.body.replace(/^[•◦](\s)/, '-$1'));
  }
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** Whether a row is the rest of the line before it, wrapped by the program that printed it. */
function joins(prev: Line, indent: number, body: string, cols: number | undefined): boolean {
  if (OWN_LINE.test(body) || indent !== prev.content) return false;
  if (cols === undefined || cols <= 0) return prev.content > prev.indent;
  return prev.lastRow > cols / 2 && prev.lastRow + 1 + firstWord(body) > cols - SLACK;
}
