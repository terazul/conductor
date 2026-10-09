/**
 * The app shell.  TRACK B.
 *
 * main.tsx discovers this by glob (`./＊/shell.tsx`, export `shell: ShellDef`)
 * and drops its fallback chrome the moment this file exists. It hands us the
 * screen nav already rendered, and the active screen as children.
 *
 * Three fixed pieces, in order of importance:
 *
 *  1. THE ATTENTION RAIL.  The one element at the top that ever changes. Dark
 *     means nothing needs you; amber means it does, and how long it has waited.
 *     Everything else up there is inert chrome on purpose — if the rail is the
 *     only thing that can light up, you can trust it from across the room.
 *  2. The screen nav (built by main.tsx, styled here).
 *  3. The status bar: what the daemon is doing and what it is costing.
 *
 * There used to be a fourth, a rail of project pips down the left of every screen. It
 * was a second list of the same projects the Project screen lists by name, so it went
 * (Amendment 43); its needs-you marks moved onto that list's rows.
 *
 * That list is back on every screen, as the project navigator (Navigator.tsx, Amendment
 * 66): one list, not two, since the Project screen no longer draws its own. The top bar
 * gains the two icons that put panels away — the navigator's, always, and the Agent
 * inspector's, only on the Agent screen, because no other screen has a right panel.
 */

import type { ShellDef } from '../lib/screens.js';
import {
  useAlerts,
  useFeedStatus,
  usePending,
  useProjects,
  useStatusBar,
} from '../lib/store.js';
import { alertWord } from './describe.js';
import { openAttention } from './nav.js';
import { readSetting, useSetting, writeSetting } from '../lib/settings.js';
import { Navigator, useRoute } from './Navigator.js';
import { DETAILS_KEY, NAV_OPEN_KEY, detailsShown, navShown, rightPanelFor } from './navtree.js';
import { DAILY_KEY, dailyMeter, parseBudget } from './spend.js';
import { useNow } from './clock.js';
import { fmtAge, fmtMoney } from './ui.js';
import { chooseTheme, installTheme, nextChoice, useTheme, type ThemeChoice } from './theme.js';
import { buildTag, buildTitle, getBuild, type Build } from '../diagnostics/build.js';
import { useEffect, useState } from 'react';
import './shell.css';

// Before the first render, so the app never paints in the wrong theme.
installTheme();

// ─────────────────────────────────────────────────────────────────────────────
// The attention rail
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long each pending request has waited.
 *
 * Deliberately plain wall clock, with no replay anchoring — unlike the sparklines
 * and elapsed times in shell/clock.ts, which anchor to the newest event because a
 * wall-clock window over a recording would report a working agent as flat-lined.
 *
 * The difference is that this number is not ours. The rail is a pointer to Track
 * E's queue, and Track E ages requests against wall clock; two different answers
 * to "how long has web-ui been waiting" in one viewport is a worse bug than an
 * implausible duration in a fixture. Live, they are the same number anyway.
 */
function useWaitClock(): number {
  return useNow();
}

function AttentionRail() {
  const pending = usePending();
  const alerts = useAlerts();
  const projects = useProjects();
  const now = useWaitClock();

  if (pending.length === 0 && alerts.length === 0) {
    return (
      <div className="sh-alert is-clear">
        <i className="sh-alert-off" aria-hidden="true" />
        <span>nothing needs you</span>
        <em>every agent is running unattended</em>
      </div>
    );
  }

  // Oldest first — usePending() already sorts that way, and that is the order
  // they should be answered in.
  const waits = pending.map((p) => ({
    id: p.requestId,
    text: `${p.projectName} · ${fmtAge(now - Date.parse(p.createdAt))}`,
  }));
  // After the waits: a stopped agent doesn't age, and the request is what ⏎ answers.
  const stopped = alerts.map((a) => {
    const project = projects.find((p) => p.id === a.projectId)?.name;
    return { id: a.id, text: project ? `${project} · ${alertWord(a)}` : alertWord(a) };
  });
  const items = [...waits, ...stopped];
  const total = items.length;
  const label = [
    pending.length === 0
      ? null
      : pending.length === 1
        ? '1 agent is waiting on you'
        : `${pending.length} agents are waiting on you`,
    alerts.length === 0 ? null : alerts.length === 1 ? '1 alert' : `${alerts.length} alerts`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <button
      type="button"
      className="sh-alert is-live"
      onClick={openAttention}
      title={pending.length > 0 ? 'Go to the oldest agent waiting on you' : 'Go to what stopped'}
    >
      <i className="sh-alert-n">{total}</i>
      <span>{label}</span>
      <em>
        {items.slice(0, 3).map((w, i) => (
          <span key={w.id}>
            {i > 0 ? ' / ' : ''}
            {w.text}
          </span>
        ))}
        {total > 3 ? ` / +${total - 3} more` : ''}
        <b>{pending.length > 0 ? ' → answer next ⏎' : ' → see what stopped'}</b>
      </em>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────────────────────

const FEED_WORD: Record<string, string> = {
  live: 'daemon :7777',
  fixture: 'fixture replay',
  connecting: 'connecting…',
  reconnecting: 'reconnecting…',
  error: 'daemon unreachable',
};

const THEME_WORD: Record<ThemeChoice, string> = {
  system: '◐ system',
  light: '☀ light',
  dark: '☾ dark',
};

function ThemeToggle() {
  const { choice, theme } = useTheme();
  const next = nextChoice(choice);
  const now = choice === 'system' ? `follows the system (${theme} now)` : choice;
  return (
    <button
      type="button"
      className="sh-theme"
      onClick={() => chooseTheme(next)}
      title={`Theme: ${now}. Click for ${next}.`}
    >
      {THEME_WORD[choice]}
    </button>
  );
}

/**
 * The daemon's commit (Amendment 38), asked again each minute so a commit made while
 * the page is open shows the daemon as behind. Nothing at all in fixture mode, where
 * there is no daemon to ask.
 */
function useBuild(): Build | null {
  const [build, setBuild] = useState<Build | null>(null);
  useEffect(() => {
    let live = true;
    const ask = (): void => {
      getBuild().then(
        (b) => live && setBuild(b),
        () => live && setBuild(null),
      );
    };
    ask();
    const t = setInterval(ask, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return build;
}

/** Today's spend, and against the daily budget when there is one (Amendment 59). */
function DailySpend({ costToday }: { costToday: number }) {
  const budget = parseBudget(useSetting(DAILY_KEY));
  if (budget === null) return <span>{fmtMoney(costToday)} today</span>;
  const m = dailyMeter(costToday, budget);
  return (
    <span className="sh-spend" data-tone={m.tone} title={m.title}>
      <span className="sh-spend-bar" aria-hidden="true">
        <i style={{ width: `${Math.round(m.fraction * 100)}%` }} />
      </span>
      {m.label}
    </span>
  );
}

function StatusBar() {
  const build = useBuild();
  const status = useFeedStatus();
  const { slots, costToday, seq } = useStatusBar();
  return (
    <footer className="sh-statusbar">
      <span>
        <kbd>1</kbd>–<kbd>7</kbd> screens
      </span>
      <span>
        <kbd>⏎</kbd> answer next blocked agent
      </span>
      <span>
        <kbd>9</kbd> settings
      </span>
      <span>
        <kbd>0</kbd> diagnostics
      </span>
      <span className="sh-right">
        <span>seq {seq}</span>
        <span>
          {slots.used}/{slots.total} agent slots
        </span>
        <DailySpend costToday={costToday} />
        {build && (
          <span className="sh-build" data-behind={build.behind} title={buildTitle(build)}>
            {build.behind ? '⚠ ' : ''}
            {buildTag(build)}
          </span>
        )}
        <ThemeToggle />
        <span className="sh-feed" data-status={status}>
          ◉ {FEED_WORD[status] ?? status}
        </span>
      </span>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Panel icons (Amendment 66)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A window with its left or right side filled: the panel that side is. Filled when the
 * panel is up, so the icon says what you have, and the title says what a click does.
 */
function PaneIcon({ side, shown, onClick, what }: { side: 'left' | 'right'; shown: boolean; onClick: () => void; what: string }) {
  return (
    <button
      type="button"
      className={`sh-pane is-${side}`}
      aria-pressed={shown}
      onClick={onClick}
      title={`${shown ? 'Hide' : 'Show'} ${what}`}
    >
      <i className={`sh-pane-ico${shown ? ' is-on' : ''}`} aria-hidden="true" />
    </button>
  );
}

/** The navigator's: on every screen. Absent is up, so a first visit has it. */
function NavToggle() {
  const shown = navShown(useSetting(NAV_OPEN_KEY));
  return (
    <PaneIcon
      side="left"
      shown={shown}
      what="the project navigator"
      onClick={() => writeSetting(NAV_OPEN_KEY, navShown(readSetting(NAV_OPEN_KEY)) ? 'hidden' : null)}
    />
  );
}

/**
 * The right panel's, where there is one: only the Agent screen's inspector, through the
 * same setting its own **details** button and `i` write, so all three agree.
 */
function RightToggle({ screen }: { screen: string }) {
  const key = rightPanelFor(screen);
  // Read whatever the screen, so the hooks run in the same order on every one.
  const raw = useSetting(key ?? DETAILS_KEY);
  if (!key) return null;
  const shown = detailsShown(raw);
  return (
    <PaneIcon
      side="right"
      shown={shown}
      what="the details panel"
      onClick={() => writeSetting(key, detailsShown(readSetting(key)) ? 'hidden' : 'shown')}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function Shell({ children, nav }: { children: React.ReactNode; nav: React.ReactNode }) {
  const screen = useRoute().id;
  const navUp = navShown(useSetting(NAV_OPEN_KEY));
  return (
    <div className="sh-root conductor-grid conductor-grain">
      <header className="sh-top">
        <NavToggle />
        <div className="sh-mark">
          <i className="sh-baton" aria-hidden="true" />
          <b>CONDUCTOR</b>
        </div>
        <AttentionRail />
        <nav className="sh-screens">{nav}</nav>
        <RightToggle screen={screen} />
      </header>

      <div className="sh-body">
        {navUp && <Navigator />}
        <div className="sh-screen">{children}</div>
      </div>

      <StatusBar />
    </div>
  );
}

export const shell: ShellDef = { Component: Shell };
