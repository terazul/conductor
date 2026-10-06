/**
 * Markdown → sanitized HTML, on the server.
 *
 * TRACK C owns this file.
 *
 * Why server-side: this is how PLAN.md, DESIGN.md and the ADRs get read *while
 * agents are rewriting them*. Rendering in the browser would mean shipping a
 * markdown stack and a sanitizer into every tab and trusting each one equally;
 * rendering here means one implementation and one sanitizer configuration to
 * audit. The content is written by an LLM with shell access, so it is untrusted
 * input in the ordinary sense — `<script>` in a PLAN.md must not execute.
 *
 * Three constructs are load-bearing for the way these documents are written, and
 * all three are the ones naive renderers get wrong:
 *
 *  • TASK LISTS. `- [x]` is how an agent records progress. marked emits a
 *    disabled `<input type=checkbox>`, which is unstyleable and reads badly to a
 *    screen reader. Replaced with `<li class="done">` / `<li class="now">`, so
 *    the pane can render ◼/▸ the way the mockup does.
 *
 *  • CODE BLOCKS. Fenced, with the language preserved as `class="language-ts"`
 *    for the pane to label — and escaped, not highlighted, because a highlighter
 *    is another parser and another hole.
 *
 *  • BLOCKQUOTES. The decision log in PLAN.md is a blockquote, and it's the part
 *    a human most needs to find.
 *
 * NOTE ON `now`: the mockup styles the current task with --need (amber). That
 * token means "a human is required" and nothing else (CONTRACT.md §5.1), so the
 * class is emitted but the pane styles it with --queue. The marker is
 * "next up", which is exactly what --queue means.
 */

import { Marked, type Tokens } from 'marked';
import sanitizeHtml from 'sanitize-html';

const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mdx']);

export function isMarkdown(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MARKDOWN_EXT.has(ext);
}

/**
 * Sanitizer policy. An allowlist, so a construct nobody thought about is absent
 * rather than present. `class` is allowed only with the exact values this
 * renderer produces, which stops raw HTML in a document from borrowing a
 * status class it has no right to.
 */
const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'em', 'strong', 'del', 'a', 'span',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'img', 'details', 'summary',
  ],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    code: ['class'],
    pre: ['class'],
    li: ['class'],
    th: ['align'],
    td: ['align'],
  },
  allowedClasses: {
    // Only what the renderer below emits.
    code: ['language-*'],
    pre: ['md-code', 'md-mermaid'],
    li: ['done', 'now', 'task'],
  },
  // No `data:` anywhere: a data: URL is how an SVG becomes a script.
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  // Relative links inside the repo stay as the file wrote them. The Files pane
  // resolves them against the file's folder and follows them itself (Amendment 31).
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noreferrer noopener', target: '_blank' }),
  },
};

export interface RenderedMarkdown {
  html: string;
  /** Task-list progress, so the pane can show 2/5 without re-parsing. */
  tasks: { done: number; total: number };
}

export function renderMarkdown(src: string): RenderedMarkdown {
  let total = 0;
  let done = 0;
  let markedNext = false;

  // A fresh instance per render: the `next task` marker is per-document state,
  // and a module-level renderer would leak it between requests.
  const md = new Marked({ gfm: true, breaks: false, pedantic: false });

  md.use({
    renderer: {
      listitem(item: Tokens.ListItem): string {
        // An item's tokens are block tokens even when it is tight — a nested list or a
        // fenced block among them made parseInline throw, and the file 500'd. marked's
        // own default: tight means no <p> around the text, not inline-only.
        const body = this.parser.parse(item.tokens, !!item.loose);

        if (!item.task) return `<li>${body}</li>\n`;

        total += 1;
        if (item.checked) {
          done += 1;
          return `<li class="task done">${body}</li>\n`;
        }
        // The first unchecked task is the one being worked on next.
        if (!markedNext) {
          markedNext = true;
          return `<li class="task now">${body}</li>\n`;
        }
        return `<li class="task">${body}</li>\n`;
      },

      // Never rendered — the class on the <li> carries the state instead.
      checkbox(): string {
        return '';
      },

      code({ text, lang }: Tokens.Code): string {
        const language = (lang ?? '').trim().split(/\s+/)[0] ?? '';
        const cls = language ? ` class="language-${escapeAttr(language)}"` : '';
        /*
         * A mermaid block is marked for the page to draw (Amendment 60). It stays a code
         * block, with its source escaped as any other, so a print, an old page or a
         * diagram that can't be drawn still shows what was written.
         */
        const mermaid = language.toLowerCase() === 'mermaid' ? ' md-mermaid' : '';
        return `<pre class="md-code${mermaid}"><code${cls}>${escapeHtml(text)}\n</code></pre>\n`;
      },
    },
  });

  const html = md.parse(src, { async: false });
  return { html: sanitizeHtml(html, SANITIZE), tasks: { done, total } };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return s.replace(/[^a-zA-Z0-9_+.-]/g, '');
}
