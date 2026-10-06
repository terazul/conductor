/**
 * AskUserQuestion — option cards.
 *
 * Track E owns this file.
 *
 * The reason this screen is worth building in a browser: each option may carry a
 * `preview` HTML fragment, because we set
 * `toolConfig.askUserQuestion.previewFormat = 'html'`. Claude's own rendering of
 * the option appears inline. A terminal orchestrator cannot do this at all.
 *
 * `preview` is optional, so every read checks for it; an option without one
 * shows its description alone and nothing looks broken.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { Decision, PendingRequest, Question, QuestionOption } from '@conductor/shared';
import type { SubmitState } from './decisions.js';
import type { QuestionDraft } from './interaction.js';
import {
  OTHER,
  buildAnswers,
  isChosen,
  isDraftComplete,
  isQuestionAnswered,
  optionLabels,
  setOtherText,
  toggleChoice,
} from './interaction.js';
import { AgeBar, SubmitStrip } from './bits.jsx';
import { ageTier, ageToken, formatWait } from './aging.js';
import { sanitizePreview } from './describe.js';

export interface QuestionCursor {
  q: number;
  o: number;
}

export interface QuestionCardProps {
  request: PendingRequest;
  waitMs: number;
  state: SubmitState;
  draft: QuestionDraft;
  cursor: QuestionCursor;
  onDraftChange: (d: QuestionDraft) => void;
  onCursorChange: (c: QuestionCursor) => void;
  onDecide: (d: Decision) => void;
  onRetry: () => void;
}

export function QuestionCard({
  request,
  waitMs,
  state,
  draft,
  cursor,
  onDraftChange,
  onCursorChange,
  onDecide,
  onRetry,
}: QuestionCardProps) {
  const questions = request.questions ?? [];
  const busy = state.phase === 'submitting' || state.phase === 'sent';
  const tier = ageTier(waitMs);
  const complete = isDraftComplete(questions, draft);

  // Sanitize once per request, not once per keystroke.
  const previews = useMemo(() => {
    const map = new Map<string, string>();
    for (const q of questions) {
      for (const o of q.options) {
        const safe = sanitizePreview(o.preview);
        if (safe !== null) map.set(`${q.question}\u0000${o.label}`, safe);
      }
    }
    return map;
  }, [questions]);

  const submit = () => {
    if (!complete) return;
    onDecide({ type: 'answer', answers: buildAnswers(questions, draft) });
  };

  if (questions.length === 0) {
    return (
      <div className="atn-card">
        <div className="atn-cardhead">
          <i className="atn-dot" />
          <span className="atn-lab" style={{ color: 'var(--need)' }}>
            Question
          </span>
          <span className="atn-wait" style={{ color: ageToken(tier) }}>
            waiting {formatWait(waitMs)}
          </span>
        </div>
        <div className="atn-cardbody">
          <div className="atn-note">
            This request arrived with no questions attached, so there is nothing to answer here.
            Check Diagnostics (<kbd>0</kbd>) for the raw payload.
          </div>
        </div>
        <SubmitStrip state={state} onRetry={onRetry} />
      </div>
    );
  }

  return (
    <div className="atn-card" data-critical={tier === 'critical'}>
      <div className="atn-cardhead">
        <i className="atn-dot" />
        <span className="atn-lab" style={{ color: 'var(--need)' }}>
          {questions.length > 1 ? `${questions.length} questions` : 'Question'}
        </span>
        <span className="atn-tag" data-mode={request.blockMode}>
          {request.blockMode}
        </span>
        <span className="atn-wait" style={{ color: ageToken(tier) }}>
          waiting {formatWait(waitMs)}
        </span>
      </div>

      <div className="atn-cardbody">
        <div style={{ marginBottom: 14 }}>
          <AgeBar ms={waitMs} />
        </div>

        {questions.map((q, qi) => (
          <QuestionBlock
            key={q.question}
            q={q}
            qi={qi}
            total={questions.length}
            draft={draft}
            cursor={cursor}
            previews={previews}
            disabled={busy}
            onDraftChange={onDraftChange}
            onCursorChange={onCursorChange}
          />
        ))}

        <div className="atn-actions">
          <button
            type="button"
            className="atn-btn primary"
            disabled={busy || !complete}
            title={complete ? 'Send the answer' : 'Choose an option for every question first'}
            onClick={submit}
          >
            answer &amp; next <kbd className="atn-kbd">⏎</kbd>
          </button>
          <span style={{ alignSelf: 'center', color: 'var(--ink3)', fontSize: 'var(--fs-md)' }}>
            {complete
              ? `${request.projectName} · ${request.agentRole} resumes as soon as the daemon confirms.`
              : 'Pick an option, or choose Other and say it in your own words.'}
          </span>
        </div>

        <div className="atn-note">
          {request.blockMode === 'held' ? (
            <>
              <b>Held</b> — the process is alive and the agent is warm, so this answer lands
              immediately.
            </>
          ) : (
            <>
              This request is <b>parked</b> — its session is on disk and answering relaunches it
              with <code>options.resume</code>.
            </>
          )}
        </div>
      </div>

      <SubmitStrip state={state} onRetry={onRetry} />
    </div>
  );
}

function QuestionBlock({
  q,
  qi,
  total,
  draft,
  cursor,
  previews,
  disabled,
  onDraftChange,
  onCursorChange,
}: {
  q: Question;
  qi: number;
  total: number;
  draft: QuestionDraft;
  cursor: QuestionCursor;
  previews: ReadonlyMap<string, string>;
  disabled: boolean;
  onDraftChange: (d: QuestionDraft) => void;
  onCursorChange: (c: QuestionCursor) => void;
}) {
  const labels = optionLabels(q);
  const answered = isQuestionAnswered(draft, q);
  const otherChosen = isChosen(draft, q.question, OTHER);
  const otherRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (otherChosen) otherRef.current?.focus();
  }, [otherChosen]);

  return (
    <div className="atn-q">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="atn-lab">{q.header || 'Question'}</span>
        {total > 1 && (
          <span className="atn-optnum">
            {qi + 1}/{total}
          </span>
        )}
        {q.multiSelect && (
          <span className="atn-lab" style={{ color: 'var(--ink3)' }}>
            · choose any
          </span>
        )}
        {answered && (
          <span className="atn-lab" style={{ color: 'var(--done)', marginLeft: 'auto' }}>
            ✓ answered
          </span>
        )}
      </div>

      <p className="atn-qtext">{q.question}</p>

      <div className="atn-opts" role={q.multiSelect ? 'group' : 'radiogroup'}>
        {q.options.map((o, oi) => (
          <OptionCard
            key={o.label}
            option={o}
            index={oi}
            total={labels.length}
            multiSelect={q.multiSelect}
            selected={isChosen(draft, q.question, o.label)}
            cursored={cursor.q === qi && cursor.o === oi}
            preview={previews.get(`${q.question}\u0000${o.label}`)}
            disabled={disabled}
            onPick={() => {
              onCursorChange({ q: qi, o: oi });
              onDraftChange(toggleChoice(draft, q.question, o.label, q.multiSelect));
            }}
          />
        ))}

        {/* "Other" — the text becomes the answer value, not a label. */}
        <div>
          <button
            type="button"
            className="atn-opt"
            data-selected={otherChosen}
            data-cursor={cursor.q === qi && cursor.o === q.options.length}
            disabled={disabled}
            aria-pressed={otherChosen}
            onClick={() => {
              onCursorChange({ q: qi, o: q.options.length });
              onDraftChange(toggleChoice(draft, q.question, OTHER, q.multiSelect));
            }}
          >
            <span className="atn-optrow">
              <span className="atn-mark" data-multi={q.multiSelect} data-on={otherChosen}>
                {otherChosen ? (q.multiSelect ? '✓' : '●') : ''}
              </span>
              <span className="atn-optlabel">Other…</span>
              <span className="atn-optnum">o</span>
            </span>
            <span className="atn-optdesc">
              Say it in your own words. What you type is what the agent receives.
            </span>
          </button>

          {otherChosen && (
            <textarea
              ref={otherRef}
              className="atn-ta"
              style={{ marginTop: 8 }}
              value={draft.other[q.question] ?? ''}
              placeholder="Neither — rotate on reuse but keep a 30s grace window for retries."
              disabled={disabled}
              onChange={(e) => onDraftChange(setOtherText(draft, q.question, e.target.value))}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function OptionCard({
  option,
  index,
  multiSelect,
  selected,
  cursored,
  preview,
  disabled,
  onPick,
}: {
  option: QuestionOption;
  index: number;
  total: number;
  multiSelect: boolean;
  selected: boolean;
  cursored: boolean;
  preview: string | undefined;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <div>
      <button
        type="button"
        className="atn-opt"
        data-selected={selected}
        data-cursor={cursored}
        disabled={disabled}
        aria-pressed={selected}
        onClick={onPick}
      >
        <span className="atn-optrow">
          <span className="atn-mark" data-multi={multiSelect} data-on={selected}>
            {selected ? (multiSelect ? '✓' : '●') : ''}
          </span>
          <span className="atn-optlabel">{option.label}</span>
          <span className="atn-optnum">{index + 1}</span>
        </span>
        {option.description.length > 0 && <span className="atn-optdesc">{option.description}</span>}
      </button>

      {preview !== undefined && (
        <div className="atn-preview">
          <span className="atn-previewcap">preview · rendered from the option’s HTML</span>
          {/* Sanitized server-side per the contract, scrubbed again in
              sanitizePreview() before it reaches innerHTML. */}
          <div dangerouslySetInnerHTML={{ __html: preview }} />
        </div>
      )}
    </div>
  );
}
