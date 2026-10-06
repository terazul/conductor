/**
 * Screen 4 — Needs you.
 *
 * Track E owns this file. Hotkey `4`, order 40.
 *
 * This is the screen the product exists for. Everything else is a status board;
 * this is the part that turns a blocked agent into a running one in seconds.
 *
 * Design rules it holds to:
 *  - Oldest first. `usePending()` already sorts that way.
 *  - `--need` means "a human is required" and appears nowhere decorative. The
 *    empty state is deliberately green-grey, not amber.
 *  - The queue is clearable without a mouse. `⏎` answers and advances, `⇥` skips.
 *  - Nothing here implies an agent is unblocked before the daemon confirms it;
 *    see decisions.ts.
 *  - Alerts (Amendment 28) sit below the request on screen, never above it: `⏎`
 *    answers the request, so it stays where the eye and the key both go first.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Decision, PendingRequest } from '@conductor/shared';
import type { NavParams } from '../lib/nav.js';
import type { ScreenDef } from '../lib/screens.js';
import { currentRoute, onNavigate } from '../lib/nav.js';
import { useAgents, useAlerts, usePending, useProjects } from '../lib/store.js';
import './attention.css';

import { formatWait, waitingMs } from './aging.js';
import { useDecisions } from './decisions.js';
import { requestTitle } from './describe.js';
import { useLadderPrefs } from './notify.js';
import { useNow } from './useNow.js';
import {
  NO_COMPOSER,
  OTHER,
  buildAnswers,
  emptyDraft,
  isDraftComplete,
  optionLabels,
  toggleChoice,
  type Composer,
  type QuestionDraft,
} from './interaction.js';
import { AlertCard } from './AlertCard.jsx';
import { PermissionCard } from './PermissionCard.jsx';
import { QuestionCard, type QuestionCursor } from './QuestionCard.jsx';
import { QueuePanel } from './QueuePanel.jsx';

/** Screen id, shared with ./always.tsx's navigate() target and the ScreenDef. */
const SCREEN_ID = 'attention';

/** Keys this screen consumes. Digits are left alone so screen nav keeps working. */
const CONSUMED = new Set([
  'Enter',
  'Escape',
  'Tab',
  ' ',
  'ArrowUp',
  'ArrowDown',
  'j',
  'k',
  'a',
  'e',
  'o',
]);

function isTextField(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || node.isContentEditable;
}

function Attention() {
  const pending = usePending();
  const now = useNow(pending.length > 0);
  const decisions = useDecisions(pending);
  const alerts = useAlerts();
  const agents = useAgents();
  const projects = useProjects();

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusedAlertId, setFocusedAlertId] = useState<string | null>(null);
  const [composer, setComposer] = useState<Composer>(NO_COMPOSER);
  const [draft, setDraft] = useState<QuestionDraft>(emptyDraft);
  const [cursor, setCursor] = useState<QuestionCursor>({ q: 0, o: 0 });

  /** The request on screen: the explicit focus, else the oldest unanswered. */
  const focused: PendingRequest | null = useMemo(() => {
    if (focusedId !== null) {
      const hit = pending.find((r) => r.requestId === focusedId);
      if (hit) return hit;
    }
    return pending.find((r) => !decisions.awaiting.has(r.requestId)) ?? pending[0] ?? null;
  }, [pending, focusedId, decisions.awaiting]);

  // A new request on screen is a clean slate. Keyed on the id so re-renders
  // caused by the ticking clock don't wipe a half-typed deny message.
  const focusedKey = focused?.requestId ?? '';
  useEffect(() => {
    setComposer(NO_COMPOSER);
    setDraft(emptyDraft());
    setCursor({ q: 0, o: 0 });
  }, [focusedKey]);

  /**
   * The ladder itself runs in ./always.tsx so it survives screen changes. Here
   * we only read its preferences for the inspector toggles — one owner for the
   * tab badge, not two.
   */
  const ladderPrefs = useLadderPrefs();

  /**
   * Focus the request the route names. A clicked desktop notification calls
   * `navigate('attention', { requestId })` (Amendment 3), so this is how the
   * notification lands on the right card.
   *
   * Both paths are needed. Arriving from another screen, `main.tsx` switches the
   * active screen and *then* notifies, so this component isn't mounted yet and
   * misses the event — `currentRoute()` on mount catches that. Already being on
   * screen 4 when a notification for a different request is clicked is the
   * opposite case, and that's what `onNavigate` catches.
   *
   * A bare `navigate('attention')` — pressing `4` — carries no requestId and
   * deliberately leaves the current focus alone. An alert's notification carries
   * an `alertId` instead, and its card scrolls into view.
   */
  useEffect(() => {
    const apply = (id: string, params: NavParams) => {
      if (id !== SCREEN_ID) return;
      const requestId = params['requestId'];
      if (requestId !== undefined && requestId.length > 0) setFocusedId(requestId);
      const alertId = params['alertId'];
      if (alertId !== undefined && alertId.length > 0) setFocusedAlertId(alertId);
    };
    const route = currentRoute();
    apply(route.id, route.params);
    return onNavigate(apply);
  }, []);

  /**
   * Move the focus cursor. Skips anything already sent, so `⏎ ⏎ ⏎` walks the
   * queue instead of bouncing off requests that are awaiting confirmation.
   */
  const step = useCallback(
    (delta: number, skipAnswered: boolean) => {
      if (pending.length === 0) return;
      const current = focused ? pending.findIndex((r) => r.requestId === focused.requestId) : -1;
      for (let i = 1; i <= pending.length; i += 1) {
        const idx = (current + delta * i + pending.length * (i + 1)) % pending.length;
        const next = pending[idx];
        if (!next) continue;
        if (skipAnswered && decisions.awaiting.has(next.requestId)) continue;
        setFocusedId(next.requestId);
        return;
      }
      // Everything is awaiting confirmation — keep the last one on screen
      // rather than showing an empty pane that implies the work is done.
    },
    [pending, focused, decisions.awaiting],
  );

  /** Send, and advance only if the daemon accepted the handoff. */
  const decide = useCallback(
    async (request: PendingRequest, decision: Decision) => {
      const ok = await decisions.submit(request.requestId, decision);
      if (ok) step(1, true);
    },
    [decisions, step],
  );

  // ── keyboard ──────────────────────────────────────────────────────────────
  // Registered in the capture phase so a consumed key can be stopped before
  // main.tsx's screen-switch handler sees it, without editing main.tsx.

  const live = useRef({ focused, composer, draft, cursor, decide, step, decisions });
  live.current = { focused, composer, draft, cursor, decide, step, decisions };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      const req = s.focused;
      if (!req) return;
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      // Composers own their keys (⌘⏎ commits, ⎋ cancels) — see PermissionCard.
      if (isTextField(e.target)) return;
      if (!CONSUMED.has(e.key)) return;

      const st = s.decisions.stateOf(req.requestId);
      const busy = st.phase === 'submitting' || st.phase === 'sent';
      const isQuestion = req.kind === 'question';
      const questions = req.questions ?? [];

      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      switch (e.key) {
        case 'Tab':
          consume();
          s.step(e.shiftKey ? -1 : 1, false);
          return;

        case 'Enter': {
          consume();
          if (busy) return;
          if (isQuestion) {
            if (!isDraftComplete(questions, s.draft)) return;
            void s.decide(req, { type: 'answer', answers: buildAnswers(questions, s.draft) });
          } else {
            void s.decide(req, { type: 'allow_once' });
          }
          return;
        }

        case 'Escape': {
          consume();
          if (busy) return;
          if (isQuestion) {
            setDraft(emptyDraft());
          } else if (s.composer.kind !== 'none') {
            // Back out of whatever is open, including an edit the user clicked
            // away from — ⎋ should never discard one composer by opening another.
            setComposer(NO_COMPOSER);
          } else {
            setComposer({ kind: 'deny', text: '' });
          }
          return;
        }

        case 'a': {
          consume();
          if (busy || isQuestion) return;
          const suggestions = req.suggestions ?? [];
          if (suggestions.length === 0) return;
          void s.decide(req, { type: 'allow_always', suggestions });
          return;
        }

        case 'e': {
          consume();
          if (busy || isQuestion) return;
          // Parked requests resume through `defer`, which ignores updatedInput.
          if (req.blockMode !== 'held') return;
          setComposer({ kind: 'edit', text: editSeedFor(req) });
          return;
        }

        case 'o': {
          consume();
          if (busy || !isQuestion) return;
          const q = questions[s.cursor.q];
          if (!q) return;
          setCursor({ q: s.cursor.q, o: q.options.length });
          setDraft(toggleChoice(s.draft, q.question, OTHER, q.multiSelect));
          return;
        }

        case 'ArrowUp':
        case 'ArrowDown':
        case 'j':
        case 'k': {
          if (!isQuestion) return;
          consume();
          const down = e.key === 'ArrowDown' || e.key === 'j';
          setCursor(moveCursor(questions, s.cursor, down ? 1 : -1));
          return;
        }

        case ' ': {
          if (!isQuestion) return;
          consume();
          if (busy) return;
          const q = questions[s.cursor.q];
          if (!q) return;
          const labels = optionLabels(q);
          const label = labels[s.cursor.o];
          if (label === undefined) return;
          setDraft(toggleChoice(s.draft, q.question, label, q.multiSelect));
          return;
        }
      }
    };

    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
    // Registered once. Everything it needs is read through `live` on each
    // keypress, so the listener never goes stale and never re-binds.
  }, []);

  // ── render ────────────────────────────────────────────────────────────────

  const alertCards = alerts.map((a) => (
    <AlertCard key={a.id} alert={a} agents={agents} projects={projects} focused={a.id === focusedAlertId} />
  ));
  const panel = (focusedRequest: string | null) => (
    <QueuePanel
      pending={pending}
      alerts={alerts}
      agents={agents}
      projects={projects}
      now={now}
      focusedId={focusedRequest}
      focusedAlertId={focusedAlertId}
      decisions={decisions}
      ladderPrefs={ladderPrefs}
      onFocus={setFocusedId}
      onFocusAlert={setFocusedAlertId}
    />
  );

  // Nothing to answer, but something stopped: the alerts are the screen.
  if ((pending.length === 0 || !focused) && alerts.length > 0) {
    return (
      <div className="atn-screen">
        <div className="atn-pane">
          <div className="atn-head">
            <span className="atn-crumb">
              needs you<i>/</i>
              <b>
                {alerts.length} {alerts.length === 1 ? 'alert' : 'alerts'}
              </b>
            </span>
            <i className="atn-dot" />
          </div>
          <div className="atn-body">
            <div className="atn-stack">{alertCards}</div>
          </div>
        </div>
        {panel(null)}
      </div>
    );
  }

  if (pending.length === 0 || !focused) {
    return (
      <div className="atn-screen">
        <div className="atn-pane" data-empty="true">
          <div className="atn-head" data-empty="true">
            <span className="atn-crumb">
              needs you<i>/</i>
              <b>nothing</b>
            </span>
          </div>
          <div className="atn-body">
            <div className="atn-empty">
              <b>Queue clear</b>
              <p>No agent is waiting on a human.</p>
              <p style={{ fontSize: 'var(--fs-md)' }}>
                Replay the two blocked agents with{' '}
                <code>VITE_FIXTURE=permission-requests</code>.
              </p>
            </div>
          </div>
        </div>
        {panel(null)}
      </div>
    );
  }

  const waitMs = waitingMs(focused.createdAt, now);
  const state = decisions.stateOf(focused.requestId);
  const others = pending.filter((r) => r.requestId !== focused.requestId);

  return (
    <div className="atn-screen">
      <div className="atn-pane">
        <div className="atn-head">
          <span className="atn-crumb">
            {focused.projectName}
            <i>/</i>
            <b>{focused.agentRole}</b>
          </span>
          <i className="atn-dot" />
          <span className="atn-tag">blocked · {formatWait(waitMs)}</span>
          <span className="atn-tag" data-mode={focused.blockMode}>
            {focused.blockMode === 'held' ? 'warm' : 'on disk'}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 7, alignItems: 'center' }}>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 'var(--fs-sm)', color: 'var(--ink3)' }}>
              {pending.findIndex((r) => r.requestId === focused.requestId) + 1} of {pending.length}
            </span>
            <button
              type="button"
              className="atn-btn ghost"
              disabled={pending.length < 2}
              onClick={() => step(1, false)}
            >
              ⤳ next blocked <kbd className="atn-kbd">⇥</kbd>
            </button>
          </div>
        </div>

        <div className="atn-body">
          <div className="atn-stack">
            {focused.kind === 'permission' ? (
              <PermissionCard
                request={focused}
                waitMs={waitMs}
                state={state}
                composer={composer}
                onComposerChange={setComposer}
                onDecide={(d) => void decide(focused, d)}
                onRetry={() => decisions.reset(focused.requestId)}
              />
            ) : (
              <QuestionCard
                request={focused}
                waitMs={waitMs}
                state={state}
                draft={draft}
                cursor={cursor}
                onDraftChange={setDraft}
                onCursorChange={setCursor}
                onDecide={(d) => void decide(focused, d)}
                onRetry={() => decisions.reset(focused.requestId)}
              />
            )}

            {/* Stacked peek — what you'll answer next. */}
            {others.map((r) => {
              const ms = waitingMs(r.createdAt, now);
              const sent = decisions.awaiting.has(r.requestId);
              return (
                <button
                  key={r.requestId}
                  type="button"
                  className="atn-peek"
                  onClick={() => setFocusedId(r.requestId)}
                >
                  <i className="atn-dot" />
                  <span className="atn-lab" style={{ color: 'var(--need)' }}>
                    {r.projectName} · {r.agentRole}
                  </span>
                  <span className="atn-peektext">{requestTitle(r)}</span>
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontFamily: 'var(--mono)',
                      fontSize: 'var(--fs-sm)',
                      color: 'var(--ink3)',
                      flex: 'none',
                    }}
                  >
                    {sent ? 'sent' : formatWait(ms)}
                  </span>
                  <span className="atn-kbd" style={{ color: 'var(--ink3)' }}>
                    ⇥
                  </span>
                </button>
              );
            })}

            {alertCards}
          </div>
        </div>
      </div>

      {panel(focused.requestId)}
    </div>
  );
}

/** Walks options across question boundaries so ↓ never dead-ends mid-card. */
function moveCursor(
  questions: readonly { options: unknown[]; multiSelect: boolean }[],
  cursor: QuestionCursor,
  delta: number,
): QuestionCursor {
  const counts = questions.map((q) => q.options.length + 1); // +1 for "Other"
  const flat: Array<QuestionCursor> = [];
  counts.forEach((n, qi) => {
    for (let o = 0; o < n; o += 1) flat.push({ q: qi, o });
  });
  if (flat.length === 0) return cursor;
  const at = flat.findIndex((p) => p.q === cursor.q && p.o === cursor.o);
  const next = flat[((at === -1 ? 0 : at) + delta + flat.length) % flat.length];
  return next ?? cursor;
}

function editSeedFor(request: PendingRequest): string {
  const input = request.input;
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
      const v = rec[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

export const screen: ScreenDef = {
  id: SCREEN_ID,
  label: 'Needs you',
  hotkey: '4',
  order: 40,
  Component: Attention,
};
