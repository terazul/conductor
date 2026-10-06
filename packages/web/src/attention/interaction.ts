/**
 * Interaction state for the focused request.
 *
 * Track E owns this file.
 *
 * Lives here rather than inside the cards because the keyboard handler needs to
 * know what is open before it can decide what `⏎` and `⎋` mean. One owner for
 * that state, pure transitions, and the cards stay presentational.
 */

import type { Question } from '@conductor/shared';

/** What, if anything, is open under the action row. */
export type Composer =
  | { kind: 'none' }
  /** Deny with a reason. The agent reads the message and adapts. */
  | { kind: 'deny'; text: string }
  /** Edit the command before running it. Held requests only. */
  | { kind: 'edit'; text: string };

export const NO_COMPOSER: Composer = { kind: 'none' };

// ─────────────────────────────────────────────────────────────────────────────
// AskUserQuestion drafts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sentinel for the free-text "Other" choice. Not a label the model can collide
 * with: option labels come from the SDK and never contain a NUL.
 */
export const OTHER = '\u0000other';

export interface QuestionDraft {
  /** question text → chosen option labels (or OTHER). */
  selected: Readonly<Record<string, readonly string[]>>;
  /** question text → the user's own words, when OTHER is chosen. */
  other: Readonly<Record<string, string>>;
}

export function emptyDraft(): QuestionDraft {
  return { selected: {}, other: {} };
}

export function selectionOf(draft: QuestionDraft, question: string): readonly string[] {
  return draft.selected[question] ?? [];
}

export function isChosen(draft: QuestionDraft, question: string, label: string): boolean {
  return selectionOf(draft, question).includes(label);
}

/**
 * Toggle a choice. Single-select replaces; multi-select adds and removes. Both
 * treat OTHER as just another choice, which is what keeps "Other" from needing
 * a special case at every call site.
 */
export function toggleChoice(
  draft: QuestionDraft,
  question: string,
  label: string,
  multiSelect: boolean,
): QuestionDraft {
  const current = selectionOf(draft, question);
  let next: string[];
  if (multiSelect) {
    next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
  } else {
    next = current.includes(label) && current.length === 1 ? [] : [label];
  }
  return { ...draft, selected: { ...draft.selected, [question]: next } };
}

export function setOtherText(
  draft: QuestionDraft,
  question: string,
  text: string,
): QuestionDraft {
  return { ...draft, other: { ...draft.other, [question]: text } };
}

/** OTHER chosen but nothing typed is not an answer — it's an unfinished one. */
function answeredValues(draft: QuestionDraft, question: string): string[] {
  const typed = (draft.other[question] ?? '').trim();
  const out: string[] = [];
  for (const label of selectionOf(draft, question)) {
    if (label === OTHER) {
      if (typed.length > 0) out.push(typed);
    } else {
      out.push(label);
    }
  }
  return out;
}

export function isQuestionAnswered(draft: QuestionDraft, q: Question): boolean {
  return answeredValues(draft, q.question).length > 0;
}

export function isDraftComplete(questions: readonly Question[], draft: QuestionDraft): boolean {
  return questions.length > 0 && questions.every((q) => isQuestionAnswered(draft, q));
}

/**
 * The wire shape: keys are question text, values are option labels — a bare
 * string for single-select, an array for multi. An "Other" answer contributes
 * the user's own text in place of a label, which is the whole point of offering
 * it: the agent gets the instruction, not a menu item.
 */
export function buildAnswers(
  questions: readonly Question[],
  draft: QuestionDraft,
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};
  for (const q of questions) {
    const values = answeredValues(draft, q.question);
    if (values.length === 0) continue;
    answers[q.question] = q.multiSelect ? values : (values[0] ?? '');
  }
  return answers;
}

/** Flat option list including the trailing "Other", for cursor arithmetic. */
export function optionLabels(q: Question): string[] {
  return [...q.options.map((o) => o.label), OTHER];
}
