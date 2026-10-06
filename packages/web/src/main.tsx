/**
 * App entry — mounts the shell and auto-registers every screen.
 *
 * W0 OWNS THIS FILE. Read-only for Tracks B–E.
 *
 * No track ever edits this. Screens are discovered by glob (see lib/screens.ts),
 * and Track B's shell is picked up the same way — drop in `src/shell/shell.tsx`
 * exporting `shell: ShellDef` and it replaces the bare fallback below.
 */

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@conductor/shared/tokens.css';
import './styles.css';
import { screenForKey, tabbed, type AlwaysOnDef, type ScreenDef, type ShellDef } from './lib/screens.js';
import { store, useFeedStatus, useStatusBar } from './lib/store.js';
import { currentRoute, navigate, notifyNavigation } from './lib/nav.js';

// ── discovery ───────────────────────────────────────────────────────────────
const screenMods = import.meta.glob<{ screen?: ScreenDef; screens?: ScreenDef[] }>(
  './*/route.tsx',
  { eager: true },
);
const shellMods = import.meta.glob<{ shell?: ShellDef }>('./*/shell.tsx', {
  eager: true,
});
const alwaysMods = import.meta.glob<{ alwaysOn?: AlwaysOnDef }>('./*/always.tsx', {
  eager: true,
});

const screens: ScreenDef[] = Object.entries(screenMods)
  .flatMap(([path, mod]) => {
    // `screens` (plural) added in Amendment 7: one directory owning two screens
    // had to invent a second directory containing a three-line re-export just to
    // satisfy the glob. Track B hit that with Fleet and Project.
    if (mod.screens) return mod.screens;
    if (mod.screen) return [mod.screen];
    console.warn(`[main] ${path} exports neither \`screen\` nor \`screens\` — skipped`);
    return [];
  })
  .sort((a, b) => a.order - b.order);

const shell = Object.values(shellMods).find((m) => m.shell)?.shell;

/**
 * Headless components that stay mounted across every screen change. See
 * AlwaysOnDef — the notification ladder has to keep running when the user is
 * looking at another screen, which is precisely when they need the tab badge.
 */
const alwaysOn: AlwaysOnDef[] = Object.entries(alwaysMods).flatMap(([path, mod]) => {
  if (!mod.alwaysOn) {
    console.warn(`[main] ${path} has no exported \`alwaysOn\` — skipped`);
    return [];
  }
  return [mod.alwaysOn];
});

// ── fallback chrome, used until Track B's shell lands ───────────────────────
function FallbackShell({
  children,
  nav,
}: {
  children: React.ReactNode;
  nav: React.ReactNode;
}) {
  const status = useFeedStatus();
  const { slots, costToday, seq } = useStatusBar();
  return (
    <div className="c-root conductor-grid conductor-grain">
      <header className="c-top">
        <div className="c-mark">
          <i className="c-baton" />
          <b>CONDUCTOR</b>
        </div>
        <nav className="c-nav">{nav}</nav>
        <span className="c-feed" data-status={status}>
          ◉ {status}
        </span>
      </header>
      <main className="c-main">{children}</main>
      <footer className="c-status">
        <span>seq {seq}</span>
        <span>
          {slots.used}/{slots.total} slots
        </span>
        <span>${costToday.toFixed(2)} today</span>
        <span className="c-spacer" />
        <span>W0 fallback shell — Track B replaces this</span>
      </footer>
    </div>
  );
}

function App() {
  const [active, setActive] = useState<string>(
    () => currentRoute().id || screens[0]?.id || '',
  );

  useEffect(() => {
    store.connect();
  }, []);

  /**
   * Hash-driven navigation (Amendment 3). This is what lets an `alwaysOn`
   * component — which lives in a different React tree, outside the shell — bring
   * the user to a screen. Track E's clicked desktop notification is the case:
   * without this it could focus the tab but not leave whatever screen you were on.
   */
  useEffect(() => {
    const onHash = () => {
      const { id } = currentRoute();
      if (id && screens.some((s) => s.id === id)) setActive(id);
      notifyNavigation();
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const hit = screenForKey(screens, e.key);
      if (hit) navigate(hit.id);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // A screen without a tab is still routable (Amendment 42); it just isn't listed.
  const nav = tabbed(screens).map((s) => (
    <button
      key={s.id}
      className={s.id === active ? 'on' : ''}
      onClick={() => navigate(s.id)}
      type="button"
    >
      <b>{s.hotkey}</b>
      {s.label}
    </button>
  ));

  const Current = screens.find((s) => s.id === active)?.Component;
  const body = Current ? (
    <Current />
  ) : (
    <div className="c-empty">
      <p>No screens registered yet.</p>
      <p>
        Add <code>src/&lt;track&gt;/route.tsx</code> exporting <code>screen</code>.
      </p>
    </div>
  );

  const Shell = shell?.Component ?? FallbackShell;
  return (
    <>
      <Shell nav={nav}>{body}</Shell>
      {/* Outside the Shell on purpose: these must survive every screen change,
          and must not sit in the shell's layout flow. */}
      {alwaysOn.map(({ id, Component }) => (
        <Component key={id} />
      ))}
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
