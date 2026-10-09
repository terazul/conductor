/**
 * Screen registration contract.
 *
 * W0 OWNS THIS FILE. Read-only for Tracks B–E.
 *
 * Adding a screen means adding a FILE, never editing a shared router:
 *
 *   packages/web/src/<yourtrack>/route.tsx
 *     export const screen: ScreenDef = {
 *       id: 'fleet', label: 'Fleet', hotkey: '1', order: 10, Component: Fleet,
 *     };
 *
 * main.tsx globs `./＊/route.tsx` and builds the nav from whatever it finds.
 *
 * A directory owning MORE THAN ONE screen exports the plural instead (added in
 * Amendment 7 — before it, Track B had to create a second directory holding a
 * three-line re-export just to satisfy the glob):
 *
 *   export const screens: ScreenDef[] = [fleetScreen, projectScreen];
 *
 * Hash format: screen ids are bare — `#fleet`, NOT `#/fleet`. A leading slash
 * parses as an unknown id and lands on the "no screens registered" empty state,
 * which looks like a catastrophic regression and is not one.
 *
 * Reserved hotkeys and order, matching mockups/conductor.html, so tracks don't
 * collide on either:
 *   10  '1'  Fleet          Track B
 *   20  '2'  Project        Track B
 *   30  '3'  Agent          Track B
 *   40  '4'  Needs you      Track E
 *   50  '5'  Files          Track C
 *   60  '6'  Preview        Track D
 *   65  '7'  Branches       wave 8    (Amendment 109)
 *   70   —   Spawn          Track A   no tab (Amendment 42)
 *   90  '9'  Settings       W0        (Amendment 47)
 *   99  '0'  Diagnostics    W0
 *
 * A screen with `tab: false` is registered and routable — `navigate('spawn')` still
 * reaches it — but has no nav chip and no hotkey. Spawn is one: you start work FROM a
 * project, so it's reached from the project panel and Fleet's "+", not from the top.
 */

import type { ComponentType } from 'react';

export interface ScreenDef {
  /** Stable id, also the URL hash. */
  id: string;
  label: string;
  /** Single character, shown in the nav chip. See the reserved table above. None when `tab` is false. */
  hotkey?: string;
  /** False for a screen reached only by navigating to it: no nav chip, no hotkey. */
  tab?: boolean;
  /** Sort position in the nav. */
  order: number;
  Component: ComponentType;
}

/** The screens that get a nav chip, in nav order. */
export function tabbed<S extends Pick<ScreenDef, 'tab' | 'order'>>(screens: S[]): S[] {
  return screens.filter((s) => s.tab !== false).sort((a, b) => a.order - b.order);
}

/** The screen a key press opens, or undefined. A screen without a tab has no hotkey. */
export function screenForKey<S extends Pick<ScreenDef, 'tab' | 'hotkey'>>(
  screens: S[],
  key: string,
): S | undefined {
  return screens.find((s) => s.tab !== false && s.hotkey !== undefined && s.hotkey === key);
}

/** Optional per-track shell override. First one found wins. */
export interface ShellDef {
  Component: ComponentType<{ children: React.ReactNode; nav: React.ReactNode }>;
}

/**
 * An always-mounted, headless component.
 *
 * `main.tsx` renders only the ACTIVE screen, so anything a track needs to keep
 * running when the user is looking elsewhere cannot live in a screen. The
 * notification ladder is the motivating case: a tab badge that stops updating
 * the moment you press `1` for Fleet is worse than useless, because that is
 * exactly when you are relying on it.
 *
 * Added in the first contract amendment, after Track E reported the gap rather
 * than editing main.tsx to fix it.
 *
 * Register by adding a FILE — no shared list to edit:
 *
 *   packages/web/src/<yourtrack>/always.tsx
 *     export const alwaysOn: AlwaysOnDef = { id: 'attention-notify', Component: Notifier };
 *
 * Contract for the component:
 *  • Render `null`, or a fixed-position overlay / portal. It sits outside the
 *    shell, so anything with layout flow will land in the wrong place.
 *  • Mounted once for the life of the tab, across every screen change.
 *  • Keep it cheap. It re-renders on every store change like anything else.
 */
export interface AlwaysOnDef {
  /** Stable id, used for the React key and for debugging. */
  id: string;
  Component: ComponentType;
}
