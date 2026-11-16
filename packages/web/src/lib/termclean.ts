/**
 * A terminal selection, cleaned to paste (Amendment 218).
 *
 * What an agent CLI prints is laid out for the screen: its paragraphs are broken at the width
 * of the terminal, indented under a `⏺ `, and padded with spaces. Copied as it is, that pastes
 * as short ragged lines. This puts it back as markdown: wrapped lines joined, the common indent
 * and the `⏺ ` dropped, trailing spaces gone, blank lines kept as paragraph breaks, and list
 * markers kept with how deep each one sits.
 *
 * xterm.js already joins the lines it wrapped itself (`getSelection()`), and a line it wrapped,
 * longer than the width, came from a program that doesn't wrap, so it is left as it is. A CLI
 * that draws its own wraps (Claude Code's does) sends real line ends, so those are joined here by
 * guessing: a line that ran to near the right edge, followed by one at the same indent whose
 * first word would not have fitted, is one line. Claude Code also shows code without its ```
 * fences, so a line that looks like code (see CODE_END and CODE_START) is never joined, as best
 * this can tell. Widths count characters, so a wide character (CJK, emoji) can make a wrapped
 * line look short and leave it unjoined.
 */

export interface TermSelection {
  /** `getSelection()`: rows joined by line ends, soft wraps already joined. */
  text: string;
  /** The column the selection starts at, so its first line's end is placed as on the screen. */
  startCol?: number;
  /** The terminal's width; without it only a list item's continuation lines are joined. */
  cols?: number;
}

/** A line that ends this short of the edge may still have wrapped: CLIs keep a margin. */
const SLACK = 6;

const MARKER = /^(?:[-*+•◦]|\d{1,3}[.)])\s+/;
const FENCE = /^(?:```|~~~)/;
/** Lines that start something of their own, and are never the rest of the line before. */
const OWN_LINE = /^(?:[-*+•◦]\s|\d{1,3}[.)]\s|#{1,6}\s|>|\||```|~~~|[│┃╭╮╰╯├┤┬┴┼└┌┐┘─━═║])/;
/**
 * Code shown without a fence: a line that ends a statement, opens or closes a block, an arrow
 * function or a label (and a line ending in `:` is followed by something of its own in prose
 * too) is not joined to the next; nor is a line that closes a bracket, a comment, a `#` line or a
 * shell prompt joined to the one before. A line ending in `,` or `)` followed by an indented one
 * is never joined anyway, as the indents differ.
 */
const CODE_END = /(?:[;{}:]|=>)$/;
const CODE_START = /^(?:[}\])]|\/\/|#|\$ )/;

interface Line {
  indent: number;
  body: string;
  /** Where the words of this line start: after its marker, for a list item. */
  content: number;
  /** How far right the last screen row of it ended, to tell whether the next one is its wrap. */
  lastRow: number;
  /** xterm wrapped it (longer than the width), so it is never joined to the next. */
  long: boolean;
}

/** A blank row: a paragraph break, which runs of collapse to one, or a blank line in a fence, kept. */
type Item = Line | 'break' | 'blank';

const indentOf = (s: string): number => s.length - s.trimStart().length;
const firstWord = (s: string): number => s.trimStart().split(/\s/, 1)[0]?.length ?? 0;
const lastWord = (s: string): number => s.length - (s.lastIndexOf(' ') + 1);

export function cleanTermText({ text, startCol = 0, cols }: TermSelection): string {
  const rows = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // The reply marker is where an indent would be, so it goes the same way.
    .map((r) => r.replace(/^(\s*)⏺ /, (_m, sp: string) => `${sp}  `).trimEnd());
  const width = cols !== undefined && cols > 0 ? cols : undefined;
  const at = Math.max(0, startCol);

  // The first row starts where the selection did. That places its end, for the width test, but
  // not its indent: started mid-paragraph, it would keep a run of spaces no other row has, and
  // never join. So its indent is the next row's, unless it starts at column 0 or at a list
  // marker, where it is as on the screen. An Alt-drag (column) selection starts every row at
  // startCol, but only the first row is placed there; the rest are taken from column 0.
  const firstIndent = (row: string): number => {
    const own = at + indentOf(row);
    if (at === 0 || MARKER.test(row.trimStart())) return own;
    const next = rows.find((r, i) => i > 0 && r.trim() !== '');
    return next === undefined ? own : Math.min(own, indentOf(next));
  };

  const items: Item[] = [];
  let fenced = false;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.trim() === '') {
      items.push(fenced ? 'blank' : 'break');
      continue;
    }
    const indent = i === 0 ? firstIndent(row) : indentOf(row);
    const body = row.trimStart();
    const end = (i === 0 ? at : 0) + row.length;
    const long = width !== undefined && end > width;
    const prev = items[items.length - 1];
    const fence = FENCE.test(body);
    if (typeof prev === 'object' && !fenced && !fence && !long && joins(prev, indent, body, width)) {
      prev.body += (broken(prev, indent, body, width) ? '' : ' ') + body;
      prev.lastRow = end;
    } else {
      const marker = MARKER.exec(body);
      items.push({ indent, body, content: indent + (marker ? marker[0].length : 0), lastRow: end, long });
    }
    if (fence) fenced = !fenced;
  }

  // A loop, not Math.min(...): a selection of the whole scrollback is too many arguments.
  let shared = Infinity;
  for (const l of items) if (typeof l === 'object' && l.indent < shared) shared = l.indent;
  const out: string[] = [];
  for (const l of items) {
    if (l === 'break') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (l === 'blank') {
      out.push('');
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
  if (OWN_LINE.test(body) || CODE_START.test(body) || CODE_END.test(prev.body) || indent !== prev.content || prev.long) return false;
  if (cols === undefined) return prev.content > prev.indent;
  // A short line, a heading the CLI drew in bold among them, ended well before the edge.
  return prev.lastRow > cols / 2 && prev.lastRow + 1 + firstWord(body) > cols - SLACK;
}

/**
 * Whether the break is inside a word: a word longer than the line can hold (a URL, a path) is
 * cut at the very edge, so the row before runs to it and the two halves are more than a row.
 */
function broken(prev: Line, indent: number, body: string, cols: number | undefined): boolean {
  return cols !== undefined && prev.lastRow === cols && lastWord(prev.body) + firstWord(body) > cols - indent - SLACK;
}
