/**
 * The clock.
 *
 * Track E owns this file.
 *
 * One interval for the whole screen. Every aging bar, duration and escalation
 * threshold reads the same `now`, so nothing on screen disagrees with itself by
 * a tick. Stops when there is nothing waiting — an idle queue should not keep
 * re-rendering a tab nobody is looking at.
 */

import { useEffect, useState } from 'react';

export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs]);

  return now;
}
