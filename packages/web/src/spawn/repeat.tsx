/**
 * repeat… (Amendment 211): the launch you have set up, saved to run again on a rule until you
 * cancel it. "Add the ability to schedule a command to run on a periodic basis, say every day,
 * every week, etc. It will stay until I cancel it."
 *
 * What is saved is `launchBody` of the launch as it stands: the same request launch would post,
 * project, prompt, preset, agents and their autonomy, isolation and branch. The daemon launches
 * it as a new job each time it comes due, named for the schedule and the time; the rules are in
 * the daemon's session/recurring.ts.
 *
 * ONE STACK. A schedule repeats one launch; several stacks from one launch are a batch of jobs
 * the daemon makes together, and a schedule of them is not offered. Asking for more says so.
 */

import { useState } from 'react';
import type { RecurringJob } from '@conductor/shared';
import { RECURRING_NAME_MAX, everyProblem, everyWords, nextRun, recurringNameProblem } from '@conductor/shared';
import { errorText } from '../lib/errors.js';
import { fmtStamp } from '../lib/when.js';
import { DEFAULT_RULE, RuleFields, ruleOf, type RuleDraft } from '../shell/RuleFields.js';
import { saveRecurring } from './endpoints.js';
import { launchBody, type LaunchInput } from './launch.js';

/** What the name starts as: the title you gave, else the prompt's first line, cut to fit. */
export function defaultName(title: string, prompt: string): string {
  const first = title.trim() || (prompt.split('\n').find((l) => l.trim()) ?? '').trim();
  return first.length > RECURRING_NAME_MAX ? first.slice(0, RECURRING_NAME_MAX).trimEnd() : first;
}

/** Why this launch can't be saved to repeat, or null. `blocked` is why launch itself can't go. */
export function repeatRefusal(input: LaunchInput | null, stacks: number, blocked: string | null): string | null {
  if (stacks > 1) return 'A schedule repeats one stack. Set stacks to 1 to save it.';
  if (input === null) return 'Pick a project first.';
  if (input.waitForInstructions) return 'A schedule needs its work written: a job that waits for instructions would wait each time.';
  if (!input.prompt.trim()) return 'Write what needs doing first.';
  return blocked;
}

/** "every weekday at 09:00 · next 12 Nov 09:00", or why the rule isn't one. */
export function ruleLine(rule: RuleDraft, now: Date): string {
  const every = ruleOf(rule);
  const bad = everyProblem(every);
  return bad ?? `${everyWords(every)} · next ${fmtStamp(nextRun(every, now).toISOString(), now)}`;
}

export function RepeatForm({
  input,
  stacks,
  blocked,
  onClose,
}: {
  input: LaunchInput | null;
  stacks: number;
  /** Why launch can't go now (a model to pick, a role unresolved), or null. */
  blocked: string | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => (input ? defaultName(input.title, input.prompt) : ''));
  const [rule, setRule] = useState<RuleDraft>(DEFAULT_RULE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<RecurringJob | null>(null);

  const every = ruleOf(rule);
  const why = repeatRefusal(input, stacks, blocked) ?? recurringNameProblem(name) ?? everyProblem(every);

  const save = async (): Promise<void> => {
    if (why !== null || input === null) return;
    setBusy(true);
    setError(null);
    try {
      setSaved((await saveRecurring(name.trim(), every, launchBody(input))).recurring);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sp-repeat">
      <div className="sp-repeat-row">
        <span className="sp-lab">repeat as</span>
        <input
          className="sp-input sp-repeat-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={RECURRING_NAME_MAX}
          placeholder="A name for the schedule"
          spellCheck={false}
          autoComplete="off"
        />
      </div>
      <div className="sp-repeat-row">
        <RuleFields rule={rule} onChange={setRule} />
        <span className="sp-repeat-words">{ruleLine(rule, new Date())}</span>
      </div>
      <div className="sp-repeat-row">
        <button type="button" className="sp-ghost" onClick={() => void save()} disabled={why !== null || busy}>
          {busy ? 'saving…' : 'save schedule'}
        </button>
        <button type="button" className="sp-ghost" onClick={onClose}>
          close
        </button>
        <span className="sp-repeat-how">
          Each run is a new job from this setup. If the last run is still going when the next is due, that one is skipped.
        </span>
      </div>
      {why !== null && <div className="sp-note">{why}</div>}
      {error && (
        <div className="sp-error">
          Not saved<code>{error}</code>
        </div>
      )}
      {saved && (
        <div className="sp-repeat-saved">
          Saved: <b>{saved.name}</b>, {everyWords(saved.every)}, next {fmtStamp(saved.nextAt)}. It is on the project's Repeating list until
          you cancel it.
        </div>
      )}
    </div>
  );
}
