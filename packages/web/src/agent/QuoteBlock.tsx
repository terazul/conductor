/**
 * A quote in an agent's reply (Amendment 204): what an agent often wraps a message in, the one you
 * asked it to write, with a ⧉ copy of its own that copies just the message, unquoted.
 *
 * The reply's ⧉ copy (Amendment 201) keeps a quote a quote, and mail and Teams draw that as a bar
 * down the left; so this copies what is inside it, as the agent wrote it without the `> ` marks
 * and rendered with no colour, so it pastes as plain paragraphs in a black or a white window. The
 * button sits beside the quote, not in it, so the quote's own markup is unchanged and the reply's
 * copy drops it with the app's other controls (`cleanHtml`'s CHROME).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyRich } from '../lib/clipboard.js';

export function QuoteBlock({ source, children }: { source: string; children: ReactNode }) {
  const [said, setSaid] = useState<{ ok: boolean; why?: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const say = (next: { ok: boolean; why?: string }): void => {
    setSaid(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), next.ok ? 2000 : 4000);
  };
  const copy = (): void => {
    // The quote's own text, drawn as a reply is: the renderer loads on the first copy.
    const html = import('./replycopy.js').then((m) => m.replyClipboard([{ kind: 'prose', text: source }]).html);
    void copyRich(source, html).then(
      () => say({ ok: true }),
      (err: unknown) => say({ ok: false, why: err instanceof Error ? err.message : String(err) }),
    );
  };

  return (
    <div className="ag-quote">
      <button
        type="button"
        className={`ag-quote-copy${said && !said.ok ? ' is-failed' : ''}`}
        aria-label="Copy this quoted message"
        title={said && !said.ok ? `Couldn't copy: ${said.why}` : 'Copy the message in this quote, without the quote bar or its colours'}
        onClick={copy}
      >
        {said ? (said.ok ? '✓ copied' : "couldn't copy") : '⧉ copy'}
      </button>
      <blockquote>{children}</blockquote>
    </div>
  );
}
