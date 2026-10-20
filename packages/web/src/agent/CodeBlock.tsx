/**
 * A fenced code block in an agent's reply (Amendment 185): what it hands you to paste
 * somewhere else, a command, a config or a message, on white with a ⧉ copy for all of it.
 *
 * White in both themes: the box is marked `data-theme='light'`, so tokens.css gives it the
 * light theme's `--paper` and inks, as the print copy is (files/print.ts). The button says
 * "copied" for a moment, or that it couldn't, as a note's does (fleet/Notes.tsx).
 */

import { useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard.js';

export function CodeBlock({ body, lang }: { body: string; lang: string }) {
  const [said, setSaid] = useState<{ ok: boolean; why?: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const say = (next: { ok: boolean; why?: string }): void => {
    setSaid(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaid(null), next.ok ? 1500 : 4000);
  };
  const copy = (): void => {
    void copyText(body).then(
      () => say({ ok: true }),
      (err: unknown) => say({ ok: false, why: err instanceof Error ? err.message : String(err) }),
    );
  };

  return (
    <div className="ag-code" data-theme="light">
      <button
        type="button"
        className={`ag-code-copy${said && !said.ok ? ' is-failed' : ''}`}
        aria-label="Copy this block"
        title={said && !said.ok ? `Couldn't copy: ${said.why}` : 'Copy all of it'}
        onClick={copy}
      >
        {said ? (said.ok ? '✓ copied' : "couldn't copy") : '⧉ copy'}
      </button>
      <pre className={lang ? `lang-${lang}` : undefined}>
        <code>{body}</code>
      </pre>
    </div>
  );
}
