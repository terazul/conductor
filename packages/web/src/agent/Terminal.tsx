/**
 * The Agent screen's terminal (Amendment 58): type a command, it runs in this agent's
 * folder, and its output comes back here. A command runner, by the user's choice: no
 * input reaches the command, so nothing interactive — no editors, no prompts.
 */

import { useEffect, useRef, useState } from 'react';
import type { Agent } from '@conductor/shared';
import { errorText } from '../lib/errors.js';
import { clearTerminal, endLine, runCommand, stopCommand, stripAnsi, useTerminal } from '../lib/terminal.js';
import { tildePath } from '../shell/ui.js';

/** Commands typed here, newest last, for ↑ and ↓. Per tab; not worth a setting. */
const typed: string[] = [];

export function TerminalPanel({ agent }: { agent: Agent }) {
  const { runs, cwd } = useTerminal(agent.id);
  const [draft, setDraft] = useState('');
  const [back, setBack] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const running = runs.find((r) => r.endedAt === null) ?? null;
  const outLength = runs.reduce((n, r) => n + r.output.length + (r.endedAt ? 1 : 0), 0);

  // Follow the output, the way a terminal does.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [outLength, runs.length]);

  const run = async (): Promise<void> => {
    const command = draft.trim();
    if (!command || running) return;
    setError(null);
    try {
      await runCommand(agent.id, command);
      if (typed.at(-1) !== command) typed.push(command);
      setDraft('');
      setBack(-1);
    } catch (err) {
      setError(errorText(err));
    }
  };

  /*
   * The folder's last part, not its path (Amendment 61). A worktree's whole path is long,
   * and in the input row it took all the width: the input was squeezed to nothing, so
   * there was nowhere to click. The whole path is in the line above, and on hover.
   */
  const prompt = cwd ? `${cwd.split('/').filter(Boolean).pop() ?? cwd} $` : '$';
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="ag-term">
      <div className="ag-term-head">
        <span className="ag-term-note">
          Runs as you, in {cwd ? <code>{tildePath(cwd)}</code> : "this agent's folder"}. One command at a time, with no
          input: nothing interactive.
        </span>
        {running ? (
          <button type="button" className="fl-btn is-danger" onClick={() => void stopCommand(running.id)}>
            ■ stop
          </button>
        ) : (
          runs.length > 0 && (
            <button type="button" className="fl-btn is-ghost" onClick={() => void clearTerminal(agent.id).catch((e) => setError(errorText(e)))}>
              clear
            </button>
          )
        )}
      </div>
      {/* A click in the output puts you back at the prompt, as in a terminal — unless you were selecting text. */}
      <div
        className="ag-term-out"
        role="log"
        aria-live="polite"
        onClick={() => {
          if (!window.getSelection()?.toString()) input.current?.focus();
        }}
      >
        {runs.map((r) => (
          <div key={r.id} className="ag-term-run">
            <div className="ag-term-cmd" title={r.cwd}>
              <span className="ag-term-prompt">{prompt}</span> {r.command}
            </div>
            {r.output.map((c, i) => (
              <pre key={i} className={c.stream === 'err' ? 'is-err' : undefined}>
                {stripAnsi(c.text)}
              </pre>
            ))}
            <div className={`ag-term-end${r.endedAt && (r.exitCode ?? 0) !== 0 ? ' is-fail' : ''}`}>{endLine(r)}</div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <div className="ag-term-in">
        <span className="ag-term-prompt" title={cwd ?? undefined}>
          {prompt}
        </span>
        <input
          ref={input}
          autoFocus
          value={draft}
          spellCheck={false}
          autoComplete="off"
          placeholder={running ? 'running — ■ stop to end it' : 'git status, npm test, ls …   ⏎ runs, ↑ ↓ history'}
          disabled={running !== null}
          aria-label="Command"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void run();
            } else if (e.key === 'ArrowUp' && typed.length > 0) {
              e.preventDefault();
              const i = back < 0 ? typed.length - 1 : Math.max(0, back - 1);
              setBack(i);
              setDraft(typed[i] ?? '');
            } else if (e.key === 'ArrowDown' && back >= 0) {
              e.preventDefault();
              const i = back + 1;
              setBack(i >= typed.length ? -1 : i);
              setDraft(i >= typed.length ? '' : (typed[i] ?? ''));
            }
          }}
        />
      </div>
      {error && <div className="ag-term-err">{error}</div>}
    </div>
  );
}
