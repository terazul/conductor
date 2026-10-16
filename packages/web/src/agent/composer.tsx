/**
 * The composer.  TRACK B.
 *
 * You can type to a working agent — it keeps going while you do, and the message
 * lands as a user turn on its next pass.
 *
 * THE PILLS ARE THE PERMISSION POLICY, not a display of it. Flipping "ask before
 * bash" off is what stops the agent interrupting you for shell commands, and it
 * goes to the daemon as a `SetAutonomyRequest`.
 *
 * A NOTE ON COLOUR.  The mockup renders the "ask before …" pills, and the send
 * button, in amber. Neither is amber here, deliberately: both are lit whenever
 * the composer is on screen, which is most of the time and while nothing is
 * wrong. Amber in the product means "a human is required right now", and an
 * always-on amber control two inches from the transcript is exactly the
 * decorative use that erodes it. The pills carry a ⚠ glyph and a neutral
 * outline, send is --live; amber stays on the attention rail and on genuinely
 * blocked agents.
 */

import { useDraft } from '../lib/drafts.js';
import { useEffect, useState } from 'react';
import { ceilingOf, spentOn, type Agent, type Autonomy, type EffortLevel } from '@conductor/shared';
import { BUDGET_RAISES, budgetOf, parseBudget, type Budget } from '../shell/autonomy.js';
import { Chevron, ModelSelect, fmtMoney } from '../shell/ui.js';
import { modelProblem, shortModel, useModels } from '../lib/models.js';
import { readSetting, useSetting, writeSetting } from '../lib/settings.js';
import {
  CLAUDE,
  capabilitiesOf,
  controlsFor,
  offersMode,
  parseTokens,
  providerLabel,
  providerModelProblem,
  providerOf,
  tokenWords,
  useProviderModels,
  useProviders,
} from '../lib/providers.js';
import { DEFAULT_EFFORT, EFFORTS, MERGE_WHEN_DONE_HINT, MERGE_WHEN_DONE_LABEL } from '../spawn/autonomy.js';
import { queueWhenDone, scheduleMessage, sendMessage, sentText, setAutonomy, setModel, useCommand, type Notice } from './endpoints.js';
import { LaterRow, ScheduledList, whenDoneLabel, whenDoneRefusal } from './scheduled.js';
import { fmtWhen } from '../lib/when.js';
import { agentPairWords } from '../shell/spend.js';
import { SETTINGS_KEY, WORKING_SAYS, appliesSays, dollarsLine, overSays, settingsShown, settingsSummary, settingsToggled, tokensLine } from './settingsfold.js';

interface PillDef {
  id: string;
  label: string;
  /** What being off actually costs — shown on hover, per pill. */
  hint?: string;
  /** Is it on, given the current autonomy? */
  on: (a: Autonomy) => boolean;
  /** The patch that flips it. */
  flip: (a: Autonomy, on: boolean) => Partial<Autonomy>;
  guard?: boolean;
}

const BASH = 'Bash';
/** Every MCP server's tools (Amendment 67). */
const MCP_ALL = 'mcp__*';
const WRITE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
const PUSH_RULE = 'Bash(git push:*)';

/** Is `tool` allowed outright — by bare name or by a scoped rule? */
const allows = (a: Autonomy, tool: string): boolean =>
  a.allowedTools.some((t) => t === tool || t.startsWith(`${tool}(`));

/** Is `tool` denied — by bare name or by any rule on it? */
const denies = (a: Autonomy, tool: string): boolean =>
  a.disallowedTools.some((t) => t === tool || t.startsWith(`${tool}(`));

const without = (list: string[], tools: string[]): string[] =>
  list.filter((t) => !tools.some((tool) => t === tool || t.startsWith(`${tool}(`)));

/*
 * GUARDRAILS — the same four questions the Spawn screen asks at launch, asked again
 * of a live agent (CONTRACT Amendment 25). Before this, the only one reachable here
 * was shell: an agent launched read-only stayed read-only for its whole life, and
 * the way to let it write was to kill the job and spawn another.
 *
 * Phrased as `allow X`, matching Spawn, rather than as `ask before X`. The two
 * framings were on opposite sides of the same screen and the inversion was a trap:
 * the pill lit up for the safe state in one place and the permissive state in the
 * other.
 *
 * TWO AXES, NOT ONE, and the difference matters for what each toggle promises:
 *  • `allowedTools` auto-approves before `canUseTool` is consulted. OFF therefore
 *    means "ask me", not "refuse" — the call still reaches your queue.
 *  • `disallowedTools` removes the tool from the agent entirely and survives every
 *    permission mode, including bypass. OFF there means "cannot", full stop.
 * Writes and the web use the deny axis, because "cannot write" has to hold even
 * under bypass. Shell uses the allow axis, because an agent that cannot run `git
 * log` cannot explain anything — off means asked, not forbidden.
 */
const PILLS: PillDef[] = [
  {
    id: 'bash',
    label: 'allow bash',
    guard: true,
    hint: 'On runs shell commands unattended — even the ones Claude Code itself would question. Off sends every one to your queue; it does not forbid them.',
    on: (a) => allows(a, BASH),
    flip: (a, on) => ({
      allowedTools: on ? [...without(a.allowedTools, [BASH]), BASH] : without(a.allowedTools, [BASH]),
    }),
  },
  {
    id: 'write',
    label: 'allow write',
    guard: true,
    hint: 'Off denies Edit, Write, MultiEdit and NotebookEdit outright — a deny rule holds even under bypass.',
    on: (a) => !WRITE_TOOLS.some((t) => denies(a, t)),
    flip: (a, on) => ({
      disallowedTools: on
        ? without(a.disallowedTools, WRITE_TOOLS)
        : [...without(a.disallowedTools, WRITE_TOOLS), ...WRITE_TOOLS],
    }),
  },
  {
    id: 'web',
    label: 'allow web',
    hint: 'Off denies WebFetch and WebSearch outright.',
    on: (a) => !WEB_TOOLS.some((t) => denies(a, t)),
    flip: (a, on) => ({
      disallowedTools: on
        ? without(a.disallowedTools, WEB_TOOLS)
        : [...without(a.disallowedTools, WEB_TOOLS), ...WEB_TOOLS],
    }),
  },
  {
    id: 'mcp',
    label: 'allow MCP tools',
    hint: 'On runs your MCP servers’ tools (Jira, Lucid, Obsidian…) unattended. Off sends each to your queue.',
    on: (a) => allows(a, MCP_ALL),
    flip: (a, on) => ({
      allowedTools: on ? [...without(a.allowedTools, [MCP_ALL]), MCP_ALL] : without(a.allowedTools, [MCP_ALL]),
    }),
  },
  {
    id: 'push',
    label: 'allow git push',
    guard: true,
    hint: 'Off adds a deny rule on `git push` that survives every permission mode, without forbidding git.',
    on: (a) => !a.disallowedTools.includes(PUSH_RULE),
    flip: (a, on) => ({
      disallowedTools: on
        ? a.disallowedTools.filter((t) => t !== PUSH_RULE)
        : [...a.disallowedTools, PUSH_RULE],
    }),
  },
  {
    // Amendment 144: what happens when its job finishes. Not a tool rule; the daemon reads it
    // when the job settles done (session/finish.ts).
    id: 'merge_when_done',
    label: MERGE_WHEN_DONE_LABEL,
    hint: MERGE_WHEN_DONE_HINT,
    on: (a) => a.mergeWhenDone === true,
    flip: (_a, on) => ({ mergeWhenDone: on }),
  },
];

interface ModeDef {
  id: Autonomy['mode'];
  label: string;
  /** What actually happens, in one line. Shown for whichever mode is selected. */
  says: string;
  danger?: boolean;
}

/**
 * The six permission modes, which are exactly the SDK's `PermissionMode` — Conductor's
 * `Autonomy['mode']` mirrors it 1:1 and the daemon forwards the value untranslated.
 *
 * All six were reachable from the daemon and only two from this composer, so `dontAsk`,
 * `auto` and `bypassPermissions` were dead letters in a frozen contract. `bypass`
 * additionally needs `allowDangerouslySkipPermissions` in the runner, without which the
 * SDK refuses the mode — a button for it before that change would have looked like it
 * worked and done nothing.
 */
const MODES: ModeDef[] = [
  {
    id: 'default',
    label: 'ask me',
    says: 'Stops and asks before anything that needs approval.',
  },
  {
    id: 'acceptEdits',
    label: 'auto-accept edits',
    says: 'File edits go through unattended. Shell still follows the pill above.',
  },
  {
    id: 'plan',
    label: 'plan only',
    says: 'Proposes and explains. Executes nothing at all.',
  },
  {
    id: 'dontAsk',
    label: "don't ask",
    says: 'Never interrupts you — anything not already approved is denied instead.',
  },
  {
    id: 'auto',
    label: 'auto',
    says: 'A model classifier answers the permission prompts in your place.',
  },
  {
    id: 'bypassPermissions',
    label: '⚠ bypass',
    danger: true,
    says:
      'Approves nearly everything, unattended. Deny rules still hold — a tool in ' +
      'disallowedTools is removed from the agent entirely — but shell is not one of them.',
  },
];

/** `$25` or `$25.50`, the way the field shows a cap it was given. */
const capText = (cap: number | null): string =>
  cap === null ? '' : Number.isInteger(cap) ? String(cap) : cap.toFixed(2);

export function Composer({ agent }: { agent: Agent }) {
  // Outlives the composer: switching to the terminal, another tab or a reload keeps it (Amendment 64).
  const [text, setText] = useDraft(`reply:${agent.id}`);
  const send = useCommand();
  const policy = useCommand();

  /**
   * Optimistic local copy of the autonomy, so a pill responds to the click
   * rather than to a round trip. Reset whenever the daemon reports something
   * different for this agent.
   */
  const reported = agent.autonomy;
  const [draft, setDraft] = useState<Autonomy | null>(null);
  useEffect(() => {
    setDraft(null);
  }, [reported]);

  const autonomy = draft ?? reported;

  // The same pattern for the model, which is a column of its own rather than autonomy.
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  useEffect(() => {
    setModelDraft(null);
  }, [agent.model]);
  const model = modelDraft ?? agent.model;
  const models = useModels();
  /*
   * What its engine can do (Amendment 80). A Claude agent can do everything, so its
   * composer is what it always was; another engine's shows only the controls that work
   * there, and its model comes from that engine's own list.
   */
  const claude = providerOf(agent) === CLAUDE;
  const caps = capabilitiesOf(agent, useProviders());
  const has = controlsFor(caps);
  const theirs = useProviderModels(claude ? null : providerOf(agent));
  const [modelText, setModelText] = useState<string | null>(null);
  // An agent from before Amendment 40 can hold a nickname; one can outlive its model.
  const modelWarning = claude ? modelProblem(models.catalog, model) : providerModelProblem(theirs.list, model);

  /** What is typed in the budget field, while it differs from the cap. null = the cap. */
  const [budgetText, setBudgetText] = useState<string | null>(null);
  const [budgetWhy, setBudgetWhy] = useState<string | null>(null);
  useEffect(() => {
    setBudgetText(null);
  }, [reported.budgetUsd, reported.budgetTokens]);
  const spend = budgetOf({ ...agent, autonomy });
  // What it spent today, in both units: the budget counts these, and the lifetime `costUsd` is
  // shown as information beside them (Amendment 129).
  const { usd: todayUsd, tokens: todayTokens } = spentOn(agent);
  // Today and over its whole life, side by side, in its engine's unit (Amendment 146).
  const pair = agentPairWords(agent, caps.costUsd);

  const submit = async () => {
    const body = text.trim();
    if (body.length === 0) return;
    // Every slot taken (Amendment 168): it waits for one, and the notice says so.
    const ok = await send.run('Sending a message', () => sendMessage(agent.id, { text: body }), (r) => sentText(r));
    // Only clear the box on success — a 404 must not eat what you wrote.
    if (ok) setText('');
  };

  // Send it later (Amendment 111): the same text, at a time you pick, in your local time.
  const [later, setLater] = useState(false);
  const schedule = async (at: string) => {
    const body = text.trim();
    if (body.length === 0) return;
    const ok = await send.run(
      'Scheduling a message',
      () => scheduleMessage(agent.id, at, body),
      () => `Scheduled for ${fmtWhen(at)}.`,
    );
    if (ok) {
      setText('');
      setLater(false);
    }
  };

  // Send it when the agent is done (Amendment 157): the same text, once its turn ends as `done`.
  // An orchestrator's goes sooner, at its next wake, with its helpers' report (Amendment 174).
  const doneRefused = whenDoneRefusal(agent.status);
  const orchestrator = (agent.helperCap ?? 0) > 0;
  const whenDone = async () => {
    const body = text.trim();
    if (body.length === 0) return;
    const ok = await send.run(
      'Queueing a message',
      () => queueWhenDone(agent.id, body),
      () => (orchestrator ? "Queued: it goes at its next wake, with its helpers' report, or when this turn ends done." : 'Queued: it goes when this turn ends done.'),
    );
    if (ok) setText('');
  };

  const togglePill = async (pill: PillDef) => {
    const nowOn = pill.on(autonomy);
    const patch = pill.flip(autonomy, !nowOn);
    setDraft({ ...autonomy, ...patch });
    // Merging when done isn't a tool; the rest are the next run's (Amendment 176).
    const working = agent.status === 'working' && pill.id !== 'merge_when_done';
    const ok = await policy.run(
      `Changing "${pill.label}"`,
      () => setAutonomy(agent.id, { autonomy: patch }),
      (r) => appliesSays('tools', working, r.appliesTo),
    );
    // Drop the optimistic copy either way — on success the daemon's own update
    // arrives through the store, and on failure `reported` is still the truth.
    if (!ok) setDraft(null);
  };

  /*
   * Modes are exclusive, so this sets rather than toggles. The patch carries only
   * `mode`: the route merges it over the stored autonomy
   * (`{ ...agent.autonomy, ...body.autonomy }`), so the tool lists and the budget cap
   * are preserved rather than blanked by omission.
   */
  const pickMode = async (mode: Autonomy['mode']) => {
    if (mode === autonomy.mode) return;
    setDraft({ ...autonomy, mode });
    const working = agent.status === 'working';
    const ok = await policy.run(
      `Switching to "${mode}"`,
      () => setAutonomy(agent.id, { autonomy: { mode } }),
      (r) => appliesSays('mode', working, r.appliesTo),
    );
    if (!ok) setDraft(null);
  };

  /** Same shape as pickMode: exclusive, patch-only, merged by the route. */
  const pickEffort = async (effort: EffortLevel) => {
    if (effort === (autonomy.effort ?? DEFAULT_EFFORT)) return;
    setDraft({ ...autonomy, effort });
    const working = agent.status === 'working';
    const ok = await policy.run(
      `Setting effort to "${effort}"`,
      () => setAutonomy(agent.id, { autonomy: { effort } }),
      (r) => appliesSays('effort', working, r.appliesTo),
    );
    if (!ok) setDraft(null);
  };

  /*
   * A live run picks the new model up for its next reply (`Query.setModel`); a stopped
   * agent from its next run. The daemon answers which, so the line says what happened
   * rather than what usually happens.
   */
  const pickModel = async (next: string) => {
    if (!next || next === model) return;
    setModelDraft(next);
    const ok = await policy.run(
      `Switching to ${next}`,
      () => setModel(agent.id, { model: next }),
      (r) =>
        r.appliesTo === 'now'
          ? `${r.model} — applies to the next reply.`
          : `${r.model} — takes effect on the next run.`,
    );
    if (!ok) setModelDraft(null);
  };

  /*
   * The cap, as a figure per day (Amendment 129) — what this agent may spend today, and every
   * day after, across every reply. The patch carries only `budgetUsd`; the route merges it
   * like `mode`.
   */
  const commitBudget = async (text: string) => {
    const parsed = parseBudget(text);
    if ('why' in parsed) {
      // The notice slot shows one message, and an older one outranks this — clear it,
      // or a typo gets no answer while "sonnet — takes effect…" sits there instead.
      policy.dismiss();
      setBudgetWhy(parsed.why);
      return;
    }
    setBudgetWhy(null);
    const cap = parsed.cap;
    if (cap === reported.budgetUsd) {
      setBudgetText(null);
      return;
    }
    setDraft({ ...autonomy, budgetUsd: cap });
    const was = reported.budgetUsd;
    const ok = await policy.run(
      cap === null ? 'Removing the budget' : `Setting the budget to ${fmtMoney(cap)}`,
      () => setAutonomy(agent.id, { autonomy: { budgetUsd: cap } }),
      () => {
        // A running query was started with what was left of the OLD cap, and the SDK
        // cannot be told otherwise mid-run. Saying so beats a stop that looks like a bug.
        if (agent.status === 'working' && was !== null) {
          return `From the next run — this one still stops at ${fmtMoney(was)}.`;
        }
        // Against what it spent TODAY, which is what the budget counts (Amendment 129); it only
        // stops at twice the figure, and between the two it is warned and works on.
        if (cap !== null && todayUsd >= ceilingOf(cap)) {
          return `Twice that is below the ${fmtMoney(todayUsd)} already spent today — it will not run again until raised, or tomorrow.`;
        }
        if (cap !== null && todayUsd >= cap) {
          return `That is below the ${fmtMoney(todayUsd)} already spent today — a warning only; it stops at ${fmtMoney(ceilingOf(cap))}.`;
        }
        if (agent.status === 'paused' && was !== null && todayUsd >= ceilingOf(was)) {
          return 'Raised — resume or reply to carry on.';
        }
        return '';
      },
    );
    if (!ok) {
      setDraft(null);
      setBudgetText(null);
    }
  };

  /*
   * The same cap in tokens, for an engine that reports no dollars (Amendment 77). The
   * patch carries only `budgetTokens`; null takes the cap off.
   */
  const commitTokens = async (text: string) => {
    const parsed = parseTokens(text);
    if ('why' in parsed) {
      policy.dismiss();
      setBudgetWhy(parsed.why);
      return;
    }
    setBudgetWhy(null);
    const cap = parsed.cap;
    const was = reported.budgetTokens ?? null;
    if (cap === was) {
      setBudgetText(null);
      return;
    }
    const used = todayTokens;
    setDraft({ ...autonomy, budgetTokens: cap });
    const ok = await policy.run(
      cap === null ? 'Removing the budget' : `Setting the budget to ${tokenWords(cap)} tokens`,
      () => setAutonomy(agent.id, { autonomy: { budgetTokens: cap } }),
      () => {
        if (cap !== null && used >= ceilingOf(cap)) {
          return `Twice that is below the ${tokenWords(used)} tokens already used today — it will not run again until raised, or tomorrow.`;
        }
        if (cap !== null && used >= cap) {
          return `That is below the ${tokenWords(used)} tokens already used today — a warning only; it stops at ${tokenWords(ceilingOf(cap))}.`;
        }
        if (agent.status === 'paused' && was !== null && used >= ceilingOf(was)) return 'Raised — resume or reply to carry on.';
        return '';
      },
    );
    if (!ok) {
      setDraft(null);
      setBudgetText(null);
    }
  };

  const closed = agent.status === 'done' || agent.status === 'failed';
  // Stopped on its ceiling, twice its daily budget (Amendments 124, 129); only over it, it still works.
  const atCap = spend?.state === 'ceiling' && agent.status !== 'working';
  const current = MODES.find((m) => m.id === autonomy.mode) ?? null;
  const notice: Notice | null =
    send.notice ?? policy.notice ?? (budgetWhy ? { tone: 'warn', text: budgetWhy } : null);

  // Folded or open, for every agent (Amendment 96). Folded keeps one line of what's set.
  const open = settingsShown(useSetting(SETTINGS_KEY));
  const toggleSettings = (): void => writeSetting(SETTINGS_KEY, settingsToggled(readSetting(SETTINGS_KEY)));
  const effortLabel = EFFORTS.find((e) => e.id === (autonomy.effort ?? DEFAULT_EFFORT))?.label ?? null;
  // Past the budget it says so, and where that stops it (Amendment 124).
  const pastBudget =
    spend !== null && spend.state !== 'ok'
      ? { state: spend.state, ceiling: spend.unit === 'tokens' ? tokenWords(spend.ceiling) : fmtMoney(spend.ceiling) }
      : undefined;
  const summary = settingsSummary({
    mode: current?.label ?? autonomy.mode,
    effort: has.effort ? effortLabel : null,
    model: shortModel(model),
    budget:
      has.budget === 'tokens'
        ? tokensLine(
            tokenWords(todayTokens),
            autonomy.budgetTokens ? tokenWords(autonomy.budgetTokens) : null,
            pastBudget,
          )
        : dollarsLine(fmtMoney(todayUsd), autonomy.budgetUsd === null ? null : fmtMoney(autonomy.budgetUsd), pastBudget),
  });
  // The longer sentence, for the open composer: only a warning, and where it stops.
  const budgetSays =
    spend?.state === 'over'
      ? spend.unit === 'tokens'
        ? overSays(tokenWords(spend.spent), tokenWords(spend.cap), tokenWords(spend.ceiling), true)
        : overSays(fmtMoney(spend.spent), fmtMoney(spend.cap), fmtMoney(spend.ceiling))
      : null;
  // The mode alone is the alarm now; the budget colours itself, green to red (Amendment 125).
  const summaryAlarm = current?.danger === true;

  return (
    <div className="ag-composer">
      <ScheduledList agentId={agent.id} />
      <div className="ag-cbox">
        <textarea
          className="ag-input"
          value={text}
          rows={2}
          placeholder={
            atCap
              ? `${agent.role} has reached its budget for today — raise it below to continue`
              : closed
                ? `${agent.role} has finished — a message will reopen the session`
                : `Reply to ${agent.role} — it keeps working while you type…`
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // ⏎ sends, ⌥⏎ / ⇧⏎ makes a newline.
            if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />

        <div className="ag-crow">
          {/*
           * The fold (Amendment 110): a header like every other one that opens and closes,
           * the navigator's chevron and a name, rather than a button of its own. Folded,
           * the header carries the one line of what is set, so it is the summary you click.
           */}
          <button
            type="button"
            className={`ag-fold${open ? ' is-open' : ''}`}
            aria-expanded={open}
            onClick={toggleSettings}
            title={open ? 'Hide the guardrails, interaction, effort, model and budget' : 'Show the guardrails, interaction, effort, model and budget'}
          >
            <Chevron open={open} />
            <span className="ag-fold-lab">agent</span>
            {!open && spend && <BudgetMeter spend={spend} />}
            {!open && (
              <span className={`ag-summary${summaryAlarm ? ' is-alarm' : ''}`} data-tone={spend?.tone} title={summary}>
                {summary}
              </span>
            )}
          </button>
          {open && (
          <>
          <span className="ui-lab">guardrails</span>
          {PILLS.map((p) => {
            const on = p.on(autonomy);
            /*
             * Amber marks the RESTRICTED state, not the pill being on. §5.1: --need
             * means "a human is required", and that is true when a guard is OFF —
             * shell off routes every command to your queue. Lighting the permissive
             * state amber would have inverted the only signal the product is built on.
             */
            return (
              <button
                key={p.id}
                type="button"
                className={`ag-pill${on ? ' is-on' : ''}${p.guard && !on ? ' is-guard' : ''}`}
                onClick={() => void togglePill(p)}
                disabled={policy.busy}
                title={p.hint}
              >
                {p.label}
              </button>
            );
          })}
          </>
          )}

          <div className="ag-crow-r">
            <span className="ui-lab">⇧⏎ newline</span>
            <button
              type="button"
              className={`ag-later-btn${later ? ' is-on' : ''}`}
              aria-expanded={later}
              onClick={() => setLater((v) => !v)}
              title="Send this message at a time you choose"
            >
              ⏲ later
            </button>
            <button
              type="button"
              className="ag-later-btn"
              onClick={() => void whenDone()}
              disabled={send.busy || text.trim().length === 0 || doneRefused !== null}
              title={
                doneRefused ??
                (orchestrator
                  ? "Send this message at its next wake, with its helpers' report, or when its turn ends done: one per wake, in order"
                  : 'Send this message when its turn ends done: one per turn, in order')
              }
            >
              {whenDoneLabel(orchestrator)}
            </button>
            <button
              type="button"
              className="fl-btn is-primary"
              onClick={() => void submit()}
              disabled={send.busy || text.trim().length === 0}
            >
              {send.busy ? 'sending…' : 'send'}
            </button>
          </div>
        </div>

        {later && (
          <LaterRow
            busy={send.busy}
            hasText={text.trim().length > 0}
            onSchedule={(at) => void schedule(at)}
            onClose={() => setLater(false)}
          />
        )}

        {open && (
        <>
        {/*
         * How this agent behaves. Exclusive, so it reads as a choice rather than as
         * three toggles whose combinations the user has to work out.
         */}
        <div className="ag-modes">
          <span className="ui-lab">interaction</span>
          {MODES.filter((m) => offersMode(m.id, caps, autonomy.mode)).map((m) => (
            <button
              key={m.id}
              type="button"
              className={`ag-mode${m.id === autonomy.mode ? ' is-on' : ''}${
                m.danger ? ' is-danger' : ''
              }`}
              aria-pressed={m.id === autonomy.mode}
              onClick={() => void pickMode(m.id)}
              disabled={policy.busy}
              title={m.says}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/*
         * Effort, changeable after launch for the same reason mode is: it is a query()
         * option, so it applies from the agent's next run. Useful mid-job — start an
         * exploration on `low`, then raise it once the agent reaches the part that
         * actually needs thinking.
         */}
        {has.effort && (
        <div className="ag-modes">
          <span className="ui-lab">effort</span>
          {EFFORTS.map((e) => (
            <button
              key={e.id}
              type="button"
              className={`ag-mode${e.id === (autonomy.effort ?? DEFAULT_EFFORT) ? ' is-on' : ''}`}
              aria-pressed={e.id === (autonomy.effort ?? DEFAULT_EFFORT)}
              onClick={() => void pickEffort(e.id)}
              disabled={policy.busy}
              title={e.hint}
            >
              {e.label}
            </button>
          ))}
        </div>
        )}

        {/*
         * Model and budget share a row: both are about what this agent costs.
         */}
        <div className="ag-modes">
          <span className="ui-lab">model</span>
          {claude ? (
            <ModelSelect
              catalog={models.catalog}
              value={model}
              onChange={(id) => void pickModel(id)}
              onRefresh={models.refresh}
              loading={models.loading}
              disabled={policy.busy}
              title={model}
            />
          ) : (
            /* A free-form id (Amendment 78): what the engine lists is offered, any id can be typed. */
            <span className="ui-model">
              <input
                className="ag-model-in"
                list={`ag-models-${agent.id}`}
                value={modelText ?? model}
                spellCheck={false}
                disabled={policy.busy}
                aria-label={`Model id on ${providerLabel(agent.provider)}`}
                title={model}
                onChange={(e) => setModelText(e.target.value)}
                onBlur={() => {
                  if (modelText !== null) void pickModel(modelText.trim());
                  setModelText(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (modelText !== null) void pickModel(modelText.trim());
                    setModelText(null);
                  } else if (e.key === 'Escape') setModelText(null);
                }}
              />
              <datalist id={`ag-models-${agent.id}`}>
                {(theirs.list?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName === m.id ? '' : m.displayName}
                  </option>
                ))}
              </datalist>
              <button
                type="button"
                className="ui-refresh"
                onClick={theirs.refresh}
                disabled={theirs.loading}
                title={`Ask ${providerLabel(agent.provider)} again for what it lists`}
                aria-label="Refresh the model list"
              >
                {theirs.loading ? '…' : '↻'}
              </button>
            </span>
          )}

          {has.budget === 'tokens' ? (
          <div className="ag-budget">
            <span className="ui-lab">budget</span>
            <label className="ag-budget-box" data-tone={spend?.tone}>
              <input
                className="ag-budget-in"
                inputMode="numeric"
                value={budgetText ?? (autonomy.budgetTokens ? tokenWords(autonomy.budgetTokens) : '')}
                placeholder="none"
                aria-label="Budget in tokens per day, input plus output, for this agent. It starts again at midnight. Empty for no cap."
                disabled={policy.busy}
                onChange={(e) => {
                  setBudgetText(e.target.value);
                  setBudgetWhy(null);
                }}
                onBlur={() => {
                  if (budgetText !== null) void commitTokens(budgetText);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (budgetText !== null) void commitTokens(budgetText);
                  } else if (e.key === 'Escape') {
                    setBudgetText(null);
                    setBudgetWhy(null);
                  }
                }}
              />
              tokens
            </label>
            {spend && <BudgetMeter spend={spend} />}
            <span className="ag-budget-spent" data-tone={spend?.tone} title="Used today, which the budget counts. It starts again at midnight.">
              {pair.today}
            </span>
            <span className="ag-budget-total" title="Used over its whole life: input plus output tokens. The budget does not count it.">
              · {pair.total}
            </span>
          </div>
          ) : (
          <div className="ag-budget">
            <span className="ui-lab">budget</span>
            <label className="ag-budget-box" data-tone={spend?.tone}>
              $
              <input
                className="ag-budget-in"
                inputMode="decimal"
                value={budgetText ?? capText(autonomy.budgetUsd)}
                placeholder="none"
                aria-label="Budget in dollars per day, for this agent. It starts again at midnight. Empty for no cap."
                disabled={policy.busy}
                onChange={(e) => {
                  setBudgetText(e.target.value);
                  setBudgetWhy(null);
                }}
                onBlur={() => {
                  if (budgetText !== null) void commitBudget(budgetText);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (budgetText !== null) void commitBudget(budgetText);
                  } else if (e.key === 'Escape') {
                    setBudgetText(null);
                    setBudgetWhy(null);
                  }
                }}
              />
            </label>
            {spend && <BudgetMeter spend={spend} />}
            <span
              className="ag-budget-spent"
              data-tone={spend?.tone}
              title="Spent today, which the budget counts. It starts again at midnight."
            >
              {pair.today}
            </span>
            <span className="ag-budget-total" title="Spent over its whole life. The budget does not count it.">
              · {pair.total}
            </span>
            {autonomy.budgetUsd !== null &&
              BUDGET_RAISES.map((n) => (
                <button
                  key={n}
                  type="button"
                  className="ag-mode"
                  disabled={policy.busy}
                  onClick={() => void commitBudget(String((autonomy.budgetUsd ?? 0) + n))}
                  title={`Raise the daily budget to ${fmtMoney((autonomy.budgetUsd ?? 0) + n)}`}
                >
                  +${n}
                </button>
              ))}
          </div>
          )}
        </div>
        </>
        )}

        {/*
         * The consequence, and when it starts. A working run takes a new mode and effort
         * live; its tools and budget are options of its start, so they wait for its next
         * run (Amendment 176).
         */}
        {current && (open || current.danger) && (
          <div className={`ag-modesays${current.danger ? ' is-danger' : ''}`}>
            {current.says}
            {agent.status === 'working' && (
              <span className="ag-modesays-when"> · {WORKING_SAYS}</span>
            )}
          </div>
        )}

        {modelWarning && <div className="ag-modesays is-danger">{modelWarning}</div>}

        {open && budgetSays && (
          <div className="ag-modesays ag-budgetsays" data-tone={spend?.tone} role="status">
            {budgetSays}
          </div>
        )}

        {notice && (
          <div
            className={`ag-notice t-${notice.tone}`}
            onClick={() => {
              send.dismiss();
              policy.dismiss();
              setBudgetWhy(null);
            }}
            role="status"
          >
            {notice.text}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * How full the agent's budget is, in the daily meter's colours (Amendment 125): green,
 * yellow from 75%, red from 95%. It stays full past the budget; the words say it is over.
 */
function BudgetMeter({ spend }: { spend: Budget }) {
  return (
    <span
      className="ag-meter"
      data-tone={spend.tone}
      aria-hidden="true"
      title={`${spend.pct}% of today's budget${spend.state === 'ok' ? '' : ' — over it'}`}
    >
      <i style={{ width: `${Math.round(spend.fraction * 100)}%` }} />
    </span>
  );
}
