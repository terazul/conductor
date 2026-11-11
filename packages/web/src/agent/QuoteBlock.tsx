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

/** A fence's opening or closing line, as markdown.tsx reads one. */
const FENCE = /^\s*(`{3,}|~{3,})/;
/** One level of quote mark at the start of a line. */
const MARK = /^[ \t]*>[ \t]?/;

/** `line` with up to `most` levels of `> ` taken off, and how many were. */
function strip(line: string, most: number): { depth: number; rest: string } {
  let rest = line;
  let depth = 0;
  while (depth < most && MARK.test(rest)) {
    rest = rest.replace(MARK, '');
    depth += 1;
  }
  return { depth, rest };
}

/**
 * A quote's text with every level of `> ` taken off its lines: what its ⧉ copy copies. Inside a
 * code fence only the quote's own marks come off, as many as the fence's opening line had, so a
 * `>` that is the code's (a diff's line, a shell prompt) stays.
 */
export function unquoted(source: string): string {
  const out: string[] = [];
  /** Inside a fence: how many marks its opening line had, and the fence itself. */
  let open: { depth: number; mark: string } | null = null;
  for (const line of source.split('\n')) {
    if (open === null) {
      const { depth, rest } = strip(line, Infinity);
      const f = FENCE.exec(rest);
      if (f) open = { depth, mark: f[1]! };
      out.push(rest);
    } else {
      const { rest } = strip(line, open.depth);
      const f = FENCE.exec(rest);
      if (f && f[1]![0] === open.mark[0] && f[1]!.length >= open.mark.length && rest.trim() === f[1]) open = null;
      out.push(rest);
    }
  }
  return out.join('\n');
}

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
    // The quote's own text, drawn as a reply is: the renderer loads on the first copy. A quote
    // inside it is unquoted too, so no level of it pastes with a bar or a > mark.
    const text = unquoted(source);
    const html = import('./replycopy.js').then((m) => m.replyClipboard([{ kind: 'prose', text }]).html);
    void copyRich(text, html).then(
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

/**
 * A message an agent drafted for you to send (Amendment 207): a ```message block, shown as the
 * message itself, its markdown drawn, with a ⧉ copy that copies only it, as the agent wrote it and
 * drawn with no colour, so it pastes into a mail or a chat as it reads here. Agents are told to put
 * a draft in one (the daemon's MESSAGE_LINE); before that they set it apart with --- lines, and the
 * reply's copy took the notes around it too.
 */
export function MessageBlock({ source, children }: { source: string; children: ReactNode }) {
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
    const html = import('./replycopy.js').then((m) => m.replyClipboard([{ kind: 'prose', text: source }]).html);
    void copyRich(source, html).then(
      () => say({ ok: true }),
      (err: unknown) => say({ ok: false, why: err instanceof Error ? err.message : String(err) }),
    );
  };

  return (
    <div className="ag-message">
      {/* ag-quote-copy, so the reply's copy and Cmd-C leave it out as they do a quote's (cleanHtml's CHROME). */}
      <button
        type="button"
        className={`ag-quote-copy ag-message-copy${said && !said.ok ? ' is-failed' : ''}`}
        aria-label="Copy this message"
        title={said && !said.ok ? `Couldn't copy: ${said.why}` : 'Copy just this message, without the notes around it or its colours'}
        onClick={copy}
      >
        {said ? (said.ok ? '✓ copied' : "couldn't copy") : '⧉ copy'}
      </button>
      <div className="ag-message-body">{children}</div>
    </div>
  );
}
