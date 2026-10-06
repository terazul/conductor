/**
 * The permission card.
 *
 * Track E owns this file.
 *
 * Its job: let someone answer without reading the transcript. So the card leads
 * with the exact thing that will run, in monospace, then the three facts that
 * decide the answer — where it runs, what rule stopped it, and whether it can be
 * undone — and only then the actions.
 *
 * The four actions map 1:1 onto the frozen `Decision` union. "Edit & run" is
 * offered only for `held` requests: a parked request resumes through the SDK's
 * `defer` path, which ignores `updatedInput`, so an edit there would be accepted
 * by the UI and silently dropped by the SDK. Better to disable it and say why.
 */

import { useEffect, useRef } from 'react';
import type { Decision, PendingRequest } from '@conductor/shared';
import type { SubmitState } from './decisions.js';
import type { Composer } from './interaction.js';
import { AgeBar, Kv, SubmitStrip } from './bits.jsx';
import { ageTier, ageToken, formatWait } from './aging.js';
import {
  destinationLabel,
  inputJson,
  orderedSuggestions,
  preferredSuggestion,
  primaryField,
  secondaryFields,
  suggestionRule,
} from './describe.js';

/** Fragments worth colouring amber in the command. Never decorative. */
const DESTRUCTIVE = [
  /\brm\s+-[a-z]*[rf][a-z]*/i,
  /\bgit\s+push\s+(--force|-f)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bsudo\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  /\bchmod\s+-R\b/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\b/i,
];

/** Splits the command so only the dangerous fragment gets the amber. */
function highlight(command: string): Array<{ text: string; hot: boolean }> {
  let best: { index: number; length: number } | null = null;
  for (const re of DESTRUCTIVE) {
    const m = re.exec(command);
    if (m && (best === null || m.index < best.index)) {
      best = { index: m.index, length: m[0].length };
    }
  }
  if (!best) return [{ text: command, hot: false }];
  const out: Array<{ text: string; hot: boolean }> = [];
  if (best.index > 0) out.push({ text: command.slice(0, best.index), hot: false });
  out.push({ text: command.slice(best.index, best.index + best.length), hot: true });
  const tail = command.slice(best.index + best.length);
  if (tail.length > 0) out.push({ text: tail, hot: false });
  return out;
}

export interface PermissionCardProps {
  request: PendingRequest;
  waitMs: number;
  state: SubmitState;
  composer: Composer;
  onComposerChange: (c: Composer) => void;
  onDecide: (d: Decision) => void;
  onRetry: () => void;
}

export function PermissionCard({
  request,
  waitMs,
  state,
  composer,
  onComposerChange,
  onDecide,
  onRetry,
}: PermissionCardProps) {
  const held = request.blockMode === 'held';
  const busy = state.phase === 'submitting' || state.phase === 'sent';
  const tier = ageTier(waitMs);

  const primary = primaryField(request.input);
  const command = primary?.value ?? null;
  const rest = secondaryFields(request.input, primary?.key ?? null);

  const suggestions = orderedSuggestions(request.suggestions);
  const preferred = preferredSuggestion(request.suggestions);
  const ruleText = suggestionRule(preferred);

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (composer.kind !== 'none') taRef.current?.focus();
  }, [composer.kind]);

  const submitDeny = () => {
    if (composer.kind !== 'deny') return;
    onDecide({ type: 'deny', message: composer.text.trim() });
  };

  const submitEdit = () => {
    if (composer.kind !== 'edit') return;
    onDecide({ type: 'allow_edited', updatedInput: buildUpdatedInput(request, composer.text) });
  };

  /** ⌘⏎ / Ctrl+⏎ inside a composer commits it; ⎋ backs out. */
  const composerKeys = (commit: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onComposerChange({ kind: 'none' });
    }
  };

  return (
    <div className="atn-card" data-critical={tier === 'critical'}>
      <div className="atn-cardhead">
        <i className="atn-dot" />
        <span className="atn-lab" style={{ color: 'var(--need)' }}>
          Permission required
        </span>
        <span className="atn-tag" data-mode={request.blockMode}>
          {request.blockMode}
        </span>
        <span className="atn-wait" style={{ color: ageToken(tier) }}>
          waiting {formatWait(waitMs)}
        </span>
      </div>

      <div className="atn-cardbody">
        {command !== null ? (
          <div className="atn-cmd">
            {primary?.key === 'command' && <span className="sigil">$ </span>}
            {highlight(command).map((part, i) =>
              part.hot ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
            )}
          </div>
        ) : (
          <pre className="atn-cmd">{inputJson(request.input)}</pre>
        )}

        <Kv k="tool" v={request.toolName} />
        {request.cwd !== undefined && <Kv k="cwd" v={request.cwd} />}
        {request.matchedRule !== undefined && (
          <Kv k="matched rule" v={request.matchedRule} tone="var(--need)" />
        )}
        {request.reversible !== undefined && (
          <Kv
            k="reversible"
            v={`${request.reversible.value ? 'yes' : 'no'} — ${request.reversible.reason}`}
            tone={request.reversible.value ? 'var(--done)' : 'var(--fail)'}
          />
        )}
        <Kv k="agent" v={`${request.projectName} · ${request.agentRole}`} />
        {rest.length > 0 &&
          rest.map(([k, v]) => <Kv key={k} k={k} v={v.length > 160 ? `${v.slice(0, 160)}…` : v} />)}

        <div style={{ marginTop: 12 }}>
          <AgeBar ms={waitMs} />
        </div>

        {composer.kind === 'none' ? (
          <div className="atn-actions">
            <button
              type="button"
              className="atn-btn primary"
              disabled={busy}
              onClick={() => onDecide({ type: 'allow_once' })}
            >
              allow once <kbd className="atn-kbd">⏎</kbd>
            </button>

            <button
              type="button"
              className="atn-btn"
              disabled={busy || suggestions.length === 0}
              title={
                suggestions.length === 0
                  ? 'The daemon sent no rule suggestions for this call.'
                  : `Persists to ${destinationLabel(preferred?.destination ?? '')}`
              }
              onClick={() => onDecide({ type: 'allow_always', suggestions })}
            >
              allow {ruleText !== null && <code>{ruleText}</code>} all session{' '}
              <kbd className="atn-kbd">a</kbd>
            </button>

            <button
              type="button"
              className="atn-btn"
              disabled={busy || !held}
              title={
                held
                  ? 'Change the command, then run it'
                  : 'Unavailable while parked — resuming goes through the SDK’s defer path, which ignores an edited input.'
              }
              onClick={() =>
                onComposerChange({ kind: 'edit', text: command ?? inputJson(request.input) })
              }
            >
              ✎ edit &amp; run <kbd className="atn-kbd">e</kbd>
            </button>

            <button
              type="button"
              className="atn-btn danger"
              disabled={busy}
              onClick={() => onComposerChange({ kind: 'deny', text: '' })}
            >
              deny <kbd className="atn-kbd">⎋</kbd>
            </button>
          </div>
        ) : composer.kind === 'deny' ? (
          <div style={{ marginTop: 14 }}>
            <span className="atn-lab" style={{ display: 'block', marginBottom: 6 }}>
              Why not? — the agent reads this and adapts
            </span>
            <textarea
              ref={taRef}
              className="atn-ta"
              data-danger="true"
              value={composer.text}
              placeholder="Don't delete dist/ — just run the build; Vite will overwrite what matters."
              onChange={(e) => onComposerChange({ kind: 'deny', text: e.target.value })}
              onKeyDown={composerKeys(submitDeny)}
            />
            <div className="atn-actions">
              <button type="button" className="atn-btn danger" disabled={busy} onClick={submitDeny}>
                deny <kbd className="atn-kbd">⌘⏎</kbd>
              </button>
              <button
                type="button"
                className="atn-btn ghost"
                onClick={() => onComposerChange({ kind: 'none' })}
              >
                cancel <kbd className="atn-kbd">⎋</kbd>
              </button>
              <span style={{ alignSelf: 'center', color: 'var(--ink3)', fontSize: 'var(--fs-md)' }}>
                A reason is optional, but it turns a dead end into a redirect.
              </span>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <span className="atn-lab" style={{ display: 'block', marginBottom: 6 }}>
              {primary ? `Edit ${primary.key}` : 'Edit tool input (JSON)'}
            </span>
            <textarea
              ref={taRef}
              className="atn-ta"
              value={composer.text}
              spellCheck={false}
              onChange={(e) => onComposerChange({ kind: 'edit', text: e.target.value })}
              onKeyDown={composerKeys(submitEdit)}
            />
            <div className="atn-actions">
              <button
                type="button"
                className="atn-btn primary"
                disabled={busy || composer.text.trim().length === 0}
                onClick={submitEdit}
              >
                run edited <kbd className="atn-kbd">⌘⏎</kbd>
              </button>
              <button
                type="button"
                className="atn-btn ghost"
                onClick={() => onComposerChange({ kind: 'none' })}
              >
                cancel <kbd className="atn-kbd">⎋</kbd>
              </button>
            </div>
          </div>
        )}

        {!held && composer.kind === 'none' && (
          <div className="atn-note">
            This request is <b>parked</b> — its session is on disk and answering relaunches it with
            <code> options.resume</code>. “Edit &amp; run” is unavailable because the SDK’s{' '}
            <code>defer</code> path ignores <code>updatedInput</code>; an edit here would look
            accepted and quietly not happen. Deny with a reason instead — the agent reads it.
          </div>
        )}
        {held && composer.kind === 'none' && (
          <div className="atn-note">
            <b>Held</b> — the process is alive and the agent is warm, so this answer lands
            immediately.
          </div>
        )}
      </div>

      <SubmitStrip state={state} onRetry={onRetry} />
    </div>
  );
}

/**
 * Rebuild the tool input with the user's edit in the right field. Editing the
 * primary field keeps the rest of the input intact; when there was no primary
 * field to find, the textarea held raw JSON and we parse it back, falling back
 * to the original rather than sending something malformed.
 */
function buildUpdatedInput(request: PendingRequest, text: string): unknown {
  const primary = primaryField(request.input);
  if (primary) {
    const base =
      typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input)
        ? (request.input as Record<string, unknown>)
        : {};
    return { ...base, [primary.key]: text };
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return request.input;
  }
}
