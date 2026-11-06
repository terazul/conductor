/**
 * Putting text on the clipboard (Amendment 83).
 *
 * The browser only allows it on a secure page: localhost, 127.0.0.1 and https all are,
 * a LAN address is not. Where it can't, this throws, and the caller says so.
 */

export async function copyText(text: string): Promise<void> {
  const clipboard = (globalThis as { navigator?: Navigator }).navigator?.clipboard;
  if (!clipboard?.writeText) throw new Error("This page can't use the clipboard. Open Conductor on localhost.");
  await clipboard.writeText(text);
}

/**
 * Text and HTML together (Amendment 201): a reply's markdown as `text/plain`, and its
 * rendering, `cleanHtml`'d, as `text/html`, so where you paste it draws it in its own colours.
 * The HTML may still be coming (the renderer loads on first use); a ClipboardItem takes a
 * promise, so the write starts inside the click. Where there is no ClipboardItem, or the
 * write is refused, it is the text alone.
 */
export async function copyRich(text: string, html: Promise<string>): Promise<void> {
  const clipboard = (globalThis as { navigator?: Navigator }).navigator?.clipboard;
  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (clipboard?.write && Item) {
    try {
      await clipboard.write([
        new Item({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': html.then((h) => new Blob([h], { type: 'text/html' })),
        }),
      ]);
      return;
    } catch {
      // Refused, or the HTML failed: the text is still worth having.
    }
  }
  await copyText(text);
}

// ── copied HTML, without the app's colours (Amendment 201) ────────────────────

/** What survives as itself: a document's structure, and nothing that carries a look. */
const KEEP = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote',
  'pre', 'code', 'strong', 'b', 'em', 'i', 'u', 'del', 's', 'sub', 'sup', 'a',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
]);
/** Gone with what's in them: drawings (a mermaid SVG is the theme's colours), scripts, controls. */
const DROP = new Set(['svg', 'style', 'script', 'template', 'textarea', 'select', 'img', 'math', 'canvas']);
const VOID = new Set(['br', 'hr', 'input', 'img', 'wbr', 'col', 'source', 'meta', 'link', 'area', 'embed', 'track']);
/** The app's own controls, which are not what you copied: their buttons, the Read it box. */
const CHROME = /(?:^|\s)(?:ag-code-copy|ag-reply-copy|ag-quote-copy|ag-ack|md-diagram-toggle|md-diagram-err|ag-cursor)(?:\s|$)/;
const MONO = ' style="font-family: monospace"';

const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attrsOf(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    out.set(m[1]!.toLowerCase(), value.replace(/"/g, '&quot;'));
  }
  return out;
}

/** What a kept tag keeps: a web link, a list's start, a cell's span and alignment. Never a colour. */
function keptAttrs(tag: string, attrs: Map<string, string>): string {
  if (tag === 'pre' || tag === 'code') return MONO;
  let out = '';
  if (tag === 'a') out += ` href="${attrs.get('href')}"`;
  if (tag === 'ol' && /^\d+$/.test(attrs.get('start') ?? '')) out += ` start="${attrs.get('start')}"`;
  if (tag === 'th' || tag === 'td') {
    for (const span of ['colspan', 'rowspan']) {
      if (/^\d+$/.test(attrs.get(span) ?? '')) out += ` ${span}="${attrs.get(span)}"`;
    }
    const align = /text-align:\s*(left|center|right)/i.exec(attrs.get('style') ?? '')?.[1] ?? attrs.get('align');
    if (align && /^(left|center|right)$/i.test(align)) out += ` align="${align.toLowerCase()}"`;
  }
  return out;
}

/**
 * HTML as copied, with nothing of the app's look in it (Amendment 201): no `style` or `class`,
 * so no colour or background, and no wrapper the target can't resolve. What stays is the
 * document: headings, paragraphs, lists, quotes, tables, links (web ones; an in-app link is its
 * text), bold and the like, and code as `<pre><code>` in monospace with no background, so the
 * window you paste into draws it in its own colours, black or white. A task's box becomes ☑ or
 * ☐. Divs, spans and buttons give up their tags and keep their text; the app's controls, hidden
 * elements and drawings go with what's in them.
 *
 * Pure, on a string, for a selection's `innerHTML` or a static render: both are well formed.
 */
export function cleanHtml(html: string): string {
  let out = '';
  let last = 0;
  /** For each element open: whether its tag was written, so its close is too. */
  const open: { tag: string; kept: boolean }[] = [];
  /** Inside a dropped element: its tag, and how deep in it we are. */
  let skip: { tag: string; depth: number } | null = null;

  for (const m of html.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (skip === null && at > last) out += html.slice(last, at);
    last = at + m[0].length;
    const tag = m[2]?.toLowerCase();
    if (tag === undefined) continue; // a comment
    const closing = m[1] === '/';
    const selfClosed = /\/\s*$/.test(m[3] ?? '');

    if (skip !== null) {
      if (tag === skip.tag && !VOID.has(tag) && !selfClosed) skip.depth += closing ? -1 : 1;
      if (skip.depth === 0) skip = null;
      continue;
    }

    if (closing) {
      const i = open.map((o) => o.tag).lastIndexOf(tag);
      if (i < 0) continue;
      for (const o of open.splice(i).reverse()) if (o.kept) out += `</${o.tag}>`;
      continue;
    }

    const attrs = attrsOf(m[3] ?? '');
    if (tag === 'input') {
      if (attrs.get('type') === 'checkbox') out += attrs.has('checked') ? '☑ ' : '☐ ';
      continue;
    }
    if (DROP.has(tag) || attrs.has('hidden') || attrs.get('aria-hidden') === 'true' || CHROME.test(attrs.get('class') ?? '')) {
      if (!VOID.has(tag) && !selfClosed) skip = { tag, depth: 1 };
      continue;
    }
    const kept = KEEP.has(tag) && (tag !== 'a' || /^https?:\/\//i.test(attrs.get('href') ?? ''));
    if (kept) out += `<${tag}${keptAttrs(tag, attrs)}>`;
    if (!VOID.has(tag) && !selfClosed) open.push({ tag, kept });
  }
  if (skip === null) out += html.slice(last);
  for (const o of open.reverse()) if (o.kept) out += `</${o.tag}>`;
  return out;
}
