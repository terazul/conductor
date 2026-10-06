/**
 * Navigation.
 *
 * W0 OWNS THIS FILE. Read-only for Tracks A–E.
 *
 * Added in Amendment 3, after Track E reported that a clicked desktop
 * notification could focus the tab but not bring the user to the screen the
 * notification was about — `main.tsx` owned the active screen and ignored the
 * hash. Landing on Fleet after clicking "web-ui needs you" is exactly the kind
 * of half-working that makes someone stop trusting notifications.
 *
 * Use this instead of touching `location.hash` or `history` directly:
 *
 *   import { navigate } from '../lib/nav.js';
 *   navigate('attention');                  // jump to a screen
 *   navigate('agent', { agentId: 'agt_1' }); // ...with state for it to read
 *
 * `main.tsx` listens for hashchange, so this works from anywhere — a screen, the
 * shell, or an `alwaysOn` component sitting in a different React tree.
 */

import { useEffect, useState } from 'react';

/** Optional state handed to the target screen. Kept deliberately small. */
export type NavParams = Record<string, string>;

const listeners = new Set<(id: string, params: NavParams) => void>();

/**
 * The href `navigate()` would go to, for a real `<a>`. A link rather than an onClick
 * gets Cmd-click into a new tab and a history entry Back can return through, and
 * building both from here means the two can't disagree about the format.
 */
export function hrefFor(screenId: string, params: NavParams = {}): string {
  const qs = new URLSearchParams(params).toString();
  return qs ? `#${screenId}?${qs}` : `#${screenId}`;
}

/** Jump to a screen by id, optionally passing params it can read. */
export function navigate(screenId: string, params: NavParams = {}): void {
  const target = hrefFor(screenId, params).slice(1);
  if (location.hash.slice(1) === target) {
    // Same target — re-notify anyway so a repeat click still refocuses.
    for (const l of listeners) l(screenId, params);
    return;
  }
  location.hash = target;
}

/** Parse the current hash into a screen id and its params. */
export function currentRoute(): { id: string; params: NavParams } {
  const raw = location.hash.slice(1);
  const [id = '', qs = ''] = raw.split('?');
  return { id, params: Object.fromEntries(new URLSearchParams(qs)) };
}

/**
 * Subscribe to navigation. `main.tsx` uses this to drive the active screen;
 * a screen can use it to react to being navigated to with new params.
 * Returns an unsubscribe function.
 */
export function onNavigate(fn: (id: string, params: NavParams) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called by main.tsx on hashchange. Not for tracks. */
export function notifyNavigation(): void {
  const { id, params } = currentRoute();
  for (const l of listeners) l(id, params);
}

/**
 * Read the params your screen was navigated to with. **Use this rather than
 * wiring `onNavigate` yourself** — it covers both halves of a subtlety that is
 * easy to get half-right.
 *
 * Amendment 5, from Track E discovering it the hard way. `main.tsx` switches the
 * active screen and *then* calls `notifyNavigation()`, so there are two distinct
 * cases and each needs a different mechanism:
 *
 *   • Navigated to from ANOTHER screen — your component is not mounted when the
 *     event fires, so an `onNavigate` listener never sees it. The mount-time read
 *     of `currentRoute()` catches this one.
 *   • Navigated to while ALREADY open, with different params — you are mounted
 *     and there is no remount, so only the listener catches it.
 *
 * Wire only one and it works in testing and fails in the case you didn't try.
 *
 * Note this reports the truth, including empty params for a bare
 * `navigate('yourScreen')` such as a hotkey press. Whether "no params" means
 * "reset" or "leave my current selection alone" is your screen's policy, not
 * this hook's — Track E treats it as leave-alone, which is usually right.
 */
export function useNavParams(screenId: string): NavParams {
  const [params, setParams] = useState<NavParams>(() => {
    const route = currentRoute();
    return route.id === screenId ? route.params : {};
  });

  useEffect(
    () =>
      onNavigate((id, next) => {
        if (id === screenId) setParams(next);
      }),
    [screenId],
  );

  return params;
}
