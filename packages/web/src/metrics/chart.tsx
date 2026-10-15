/**
 * The cost-per-day chart above the day table (Amendment 165): one bar per day of the range,
 * oldest on the left, a day nothing ran included at no height, each bar's height its cost
 * over the highest day's. Hand-drawn SVG; the bars and the base line are `currentColor`, so
 * their only colour is the text ink metrics.css gives `.mt-chart`.
 *
 * Its words are the text alternative: the SVG is an image labelled by the caption under it,
 * and each day says its own cost on hover. Kept apart from route.tsx, which imports the
 * stylesheet, so metrics/verify.ts can render it under Node.
 */

import type { MetricsResponse } from '@conductor/shared';
import { barTitle, chartBars, chartSummary, dayLabel, dollars } from './rules.js';

/** The drawing's own units: a day is a slot of 10, its bar 7 of them; the bars are up to 60 tall. */
const SLOT = 10;
const BAR = 7;
const H = 60;

export function CostChart({ resp }: { resp: Pick<MetricsResponse, 'range' | 'from' | 'to' | 'days'> }) {
  const bars = chartBars(resp);
  if (bars.length === 0) return null;
  const width = bars.length * SLOT;
  const top = Math.max(...bars.map((b) => b.costUsd ?? 0));
  return (
    <figure className="mt-chart">
      <div className="mt-chart-top" aria-hidden="true">{dollars(top)}</div>
      <svg
        className="mt-chart-svg"
        viewBox={`0 0 ${width} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-labelledby="mt-chart-caption"
      >
        {bars.map((b, i) => (
          <g key={b.day} className="mt-chart-day">
            <title>{barTitle(b)}</title>
            <rect className="mt-chart-hit" x={i * SLOT} y={0} width={SLOT} height={H} />
            <rect className="mt-chart-bar" x={i * SLOT + (SLOT - BAR) / 2} y={H - b.height * H} width={BAR} height={b.height * H} />
          </g>
        ))}
        <line className="mt-chart-base" x1={0} y1={H} x2={width} y2={H} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-chart-axis" aria-hidden="true">
        <span>{dayLabel(bars[0]!.day)}</span>
        <span>{dayLabel(bars[bars.length - 1]!.day)}</span>
      </div>
      <figcaption id="mt-chart-caption" className="mt-quiet">
        {chartSummary(bars)}
      </figcaption>
    </figure>
  );
}
