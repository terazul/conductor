/**
 * What a reply's ⧉ copy puts on the clipboard (Amendment 201): its markdown, as the agent wrote
 * it, and that rendered with no colour at all, so it pastes into a black or a white window and
 * takes that window's colours. The same renderer as the transcript's, through `cleanHtml`: code
 * is `<pre><code>`, a diagram is its source, and nothing carries a `style` or a `class`.
 *
 * Its own file because it needs `react-dom/server`, which the transcript loads on the first
 * copy rather than with the app.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { cleanHtml } from '../lib/clipboard.js';
import { renderMarkdown } from './markdown.js';

/** The reply's prose, each block as the agent wrote it, as `text/plain` and as clean `text/html`. */
export function replyClipboard(reply: readonly { kind: string; text?: string }[]): { text: string; html: string } {
  const prose = reply.flatMap((b) => (b.kind === 'prose' && b.text !== undefined ? [b.text] : []));
  const html = prose.map((t) => cleanHtml(renderToStaticMarkup(<>{renderMarkdown(t)}</>))).join('');
  return { text: prose.join('\n\n'), html: `<meta charset="utf-8">${html}` };
}
