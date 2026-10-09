/**
 * The Branches screen's picture (Amendment 109, ADR 0008 § Screen): plain SVG, drawn from
 * per-branch facts rather than every commit.
 *
 *   main ●───────●──────────●────────────●   ← the target as a rail, its fork points as dots
 *              ╰──●──●──● conductor/job_a      ← a branch: a curve off its fork, its commits, its tip
 *                        ╰ feature/done        ← merged (ahead 0): dimmed, joined back into the rail
 *
 * WHERE ON THE RAIL. The response doesn't list main's own commits, but each branch's
 * `behind` says how far back from main's tip it forked, so a fork point's place on the
 * rail is its `behind`: main's tip on the right, older to the left. Each distinct place is
 * one dot; the commits between two of them are counted on the rail rather than drawn. A
 * branch that shares no history with main (`forkedAt` null) has no fork: its row starts at
 * the left edge on its own.
 *
 * `layout()` does all the arithmetic and is pure, so `branches/verify.ts` checks it without
 * a DOM. `BranchGraph` only draws what it returns. Colours come from branches.css, which
 * uses tokens only; `--live` marks a live branch and nothing else.
 */

import type { BranchInfo, BranchesResponse } from '@conductor/shared';

export const G = {
  pad: 20,
  railY: 44,
  firstRowY: 96,
  rowH: 48,
  /** Between fork points on the rail. */
  slot: 30,
  /** How far right a branch's curve lands from its fork. */
  curve: 26,
  /** Between a branch's commit dots. */
  gap: 16,
  /** At most this many commit dots per row; the rest are counted. */
  maxDots: 10,
  /** Room before the dots for "+N" when some are counted. */
  elided: 28,
  /** A rough monospace character width at the label size, for sizing the picture. */
  ch: 7.8,
  chSmall: 6.9,
} as const;

export type BadgeTone = 'behind' | 'dirty' | 'origin' | 'none' | 'live' | 'merged';

export interface Badge {
  text: string;
  tone: BadgeTone;
}

export interface RailDot {
  x: number;
  /** Commits back from the target's tip. 0 is the tip. */
  behind: number;
  /** Commits on the rail between this dot and the next one right, not drawn. */
  skipped: number;
  title: string;
}

export interface Dot {
  x: number;
  /** The commit's sha and subject, when the response carried it. */
  title: string | null;
}

export interface Row {
  branch: BranchInfo;
  y: number;
  /** Where its curve leaves the rail; null for a branch that shares no history with the target. */
  forkX: number | null;
  /** Where the curve lands and the row's line begins. */
  startX: number;
  /** Ahead 0: everything on it is already on the target. */
  dimmed: boolean;
  dots: Dot[];
  /** Commits ahead that aren't drawn, counted at `elidedX`. */
  elided: number;
  elidedX: number;
  tipX: number;
  /** The hollow dot for uncommitted work, after the tip. */
  uncommittedX: number | null;
  labelX: number;
  badges: Badge[];
  ariaLabel: string;
}

export interface Layout {
  width: number;
  height: number;
  railY: number;
  /** The target branch, when the response has it. */
  target: BranchInfo | null;
  targetBadges: Badge[];
  railDots: RailDot[];
  headX: number;
  rows: Row[];
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const short = (sha: string): string => sha.slice(0, 7);

/** The badges on a row, in the order they're drawn. */
export function badges(resp: BranchesResponse, b: BranchInfo): Badge[] {
  const out: Badge[] = [];
  if (b.live) out.push({ text: 'live', tone: 'live' });
  if (!b.isTarget && b.ahead === 0) out.push({ text: `in ${resp.target}`, tone: 'merged' });
  if (!b.isTarget && b.behind > 0) out.push({ text: `↓${b.behind} behind`, tone: 'behind' });
  const dirty = b.worktree?.uncommitted ?? 0;
  if (dirty > 0) out.push({ text: `± ${dirty} uncommitted`, tone: 'dirty' });
  if (b.upstream) out.push({ text: `${resp.remote ?? 'origin'} ↑${b.upstream.ahead} ↓${b.upstream.behind}`, tone: 'origin' });
  else if (resp.remote !== null) out.push({ text: `not on ${resp.remote}`, tone: 'none' });
  return out;
}

/** What a screen reader says for a row, with everything the picture shows. */
export function describe(resp: BranchesResponse, b: BranchInfo): string {
  const parts = [b.name];
  if (b.isTarget) parts.push(`the target branch`);
  else if (b.forkedAt === null) parts.push(`shares no history with ${resp.target}`);
  else if (b.ahead === 0) parts.push(`already in ${resp.target}`);
  else parts.push(`${plural(b.ahead, 'commit')} ahead of ${resp.target}`);
  for (const badge of badges(resp, b)) if (badge.tone !== 'merged') parts.push(badge.text);
  return parts.join(', ');
}

const badgeWidth = (bs: Badge[]): number =>
  bs.reduce((w, b) => w + b.text.length * G.chSmall + 12, 0);

/** Every position the picture needs. Pure. */
export function layout(resp: BranchesResponse): Layout {
  const target = resp.branches.find((b) => b.isTarget) ?? null;
  const others = resp.branches.filter((b) => !b.isTarget);

  // One rail dot per distinct fork distance, oldest on the left, the tip always there.
  const behinds = [...new Set([0, ...others.filter((b) => b.forkedAt !== null).map((b) => b.behind)])].sort(
    (a, b) => b - a,
  );
  const slotX = (i: number): number => G.pad + 8 + i * G.slot;
  const railDots: RailDot[] = behinds.map((behind, i) => {
    const next = behinds[i + 1];
    const skipped = next === undefined ? 0 : behind - next - 1;
    const title =
      behind === 0
        ? `${resp.target} — ${target ? `${short(target.head)} ${target.subject}` : 'its tip'}`
        : `${plural(behind, 'commit')} before ${resp.target}'s tip`;
    return { x: slotX(i), behind, skipped, title };
  });
  const headX = slotX(behinds.length - 1);
  const xOfBehind = new Map(railDots.map((d) => [d.behind, d.x]));

  const rows: Row[] = others.map((b, i) => {
    const y = G.firstRowY + i * G.rowH;
    const forkX = b.forkedAt === null ? null : (xOfBehind.get(b.behind) ?? headX);
    const startX = forkX === null ? G.pad + 8 : forkX + G.curve;
    const dimmed = b.ahead === 0;
    const shown = Math.min(Math.max(b.ahead, 0), G.maxDots);
    const elided = Math.max(b.ahead - shown, 0);
    const elidedX = startX + 4;
    const first = startX + (elided > 0 ? G.elided : forkX === null ? 0 : 6);
    // Left to right is oldest to newest; `commits` is newest first.
    const dots: Dot[] = Array.from({ length: shown }, (_, k) => {
      const c = b.commits[shown - 1 - k];
      return { x: first + k * G.gap, title: c ? `${short(c.sha)} ${c.subject}` : null };
    });
    const tipX = dots.length > 0 ? dots[dots.length - 1]!.x : startX;
    const uncommittedX = (b.worktree?.uncommitted ?? 0) > 0 ? tipX + G.gap : null;
    const labelX = (uncommittedX ?? tipX) + 14;
    return {
      branch: b,
      y,
      forkX,
      startX,
      dimmed,
      dots,
      elided,
      elidedX,
      tipX,
      uncommittedX,
      labelX,
      badges: badges(resp, b),
      ariaLabel: describe(resp, b),
    };
  });

  const targetBadges = target ? badges(resp, target) : [];
  const targetRight = G.pad + (resp.target.length + 2) * G.ch + badgeWidth(targetBadges);
  const right = Math.max(
    headX + 40,
    targetRight,
    ...rows.map((r) => r.labelX + Math.max(r.branch.name.length * G.ch, badgeWidth(r.badges))),
  );
  const last = rows[rows.length - 1];
  return {
    width: Math.ceil(right + G.pad),
    height: last ? last.y + 32 : G.railY + 32,
    railY: G.railY,
    target,
    targetBadges,
    railDots,
    headX,
    rows,
  };
}

/** The curve from the rail down to a row: leaves straight down, lands heading right. */
function forkPath(fx: number, railY: number, x: number, y: number): string {
  const mid = (railY + y) / 2;
  return `M ${fx} ${railY} C ${fx} ${mid + (y - mid) * 0.6}, ${fx + (x - fx) * 0.2} ${y}, ${x} ${y}`;
}

function Badges({ items, x, y }: { items: Badge[]; x: number; y: number }) {
  let at = x;
  return (
    <>
      {items.map((b) => {
        const el = (
          <text key={b.text} x={at} y={y} className={`br-badge br-badge-${b.tone}`}>
            {b.text}
          </text>
        );
        at += b.text.length * G.chSmall + 12;
        return el;
      })}
    </>
  );
}

export function BranchGraph({
  resp,
  selected,
  into = null,
  onSelect,
}: {
  resp: BranchesResponse;
  selected: string | null;
  /** The branch the selected one would merge into (Amendment 110), marked so you see both ends. */
  into?: string | null;
  onSelect: (name: string) => void;
}) {
  const g = layout(resp);
  const keyed = (name: string) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(name);
    }
  };
  const target = g.target;

  return (
    <svg
      className="br-graph"
      width={g.width}
      height={g.height}
      viewBox={`0 0 ${g.width} ${g.height}`}
      role="group"
      aria-label={`${resp.target} and ${plural(g.rows.length, 'other branch', 'other branches')}`}
    >
      {/* The target: a rail across the top. Selectable, so main can be committed and pushed too. */}
      <g
        className={`br-row br-target${selected === resp.target ? ' on' : ''}${into === resp.target ? ' into' : ''}${target?.live ? ' live' : ''}`}
        role="button"
        tabIndex={target ? 0 : -1}
        aria-pressed={selected === resp.target}
        aria-label={target ? describe(resp, target) : resp.target}
        onClick={() => target && onSelect(target.name)}
        onKeyDown={target ? keyed(target.name) : undefined}
      >
        <rect className="br-hit" x={0} y={4} width={g.width} height={g.railY + 14} />
        <text x={G.pad} y={g.railY - 16} className="br-name br-name-target">
          {resp.target}
        </text>
        {into === resp.target && selected && (
          <text className="br-into-tag" x={g.width - G.pad} y={g.railY - 16} textAnchor="end">
            ⇠ {selected} merges here
          </text>
        )}
        <Badges items={g.targetBadges} x={G.pad + (resp.target.length + 2) * G.ch} y={g.railY - 16} />
        <line className="br-rail" x1={G.pad - 6} y1={g.railY} x2={g.width - G.pad / 2} y2={g.railY} />
        {g.railDots.map((d, i) => (
          <g key={d.behind}>
            {d.skipped > 0 && (
              <text
                className="br-skip"
                x={(d.x + (g.railDots[i + 1]?.x ?? d.x)) / 2}
                y={g.railY - 5}
                textAnchor="middle"
              >
                {d.skipped}
              </text>
            )}
            <circle className={`br-dot br-dot-rail${d.behind === 0 ? ' head' : ''}`} cx={d.x} cy={g.railY} r={d.behind === 0 ? 5.5 : 4.5}>
              <title>{d.title}</title>
            </circle>
          </g>
        ))}
      </g>

      {g.rows.map((r) => {
        const b = r.branch;
        const cls = ['br-row', r.dimmed ? 'dim' : '', b.live ? 'live' : '', selected === b.name ? 'on' : '', into === b.name ? 'into' : '']
          .filter(Boolean)
          .join(' ');
        const lineEnd = r.uncommittedX ?? r.tipX;
        return (
          <g
            key={b.name}
            className={cls}
            role="button"
            tabIndex={0}
            aria-pressed={selected === b.name}
            aria-label={r.ariaLabel}
            onClick={() => onSelect(b.name)}
            onKeyDown={keyed(b.name)}
          >
            <rect className="br-hit" x={0} y={r.y - G.rowH / 2} width={g.width} height={G.rowH} />
            {r.forkX !== null ? (
              <path className="br-edge" d={forkPath(r.forkX, g.railY, r.startX, r.y)} />
            ) : (
              <rect className="br-root" x={r.startX - 4} y={r.y - 4} width={8} height={8}>
                <title>{`${b.name} shares no history with ${resp.target}`}</title>
              </rect>
            )}
            {lineEnd > r.startX && <line className="br-line" x1={r.startX} y1={r.y} x2={lineEnd} y2={r.y} />}
            {r.elided > 0 && (
              <text className="br-skip" x={r.elidedX} y={r.y - 6}>
                +{r.elided}
              </text>
            )}
            {r.dots.map((d, k) => (
              <circle key={k} className="br-dot" cx={d.x} cy={r.y} r={4.5}>
                {d.title && <title>{d.title}</title>}
              </circle>
            ))}
            {r.dimmed && r.forkX !== null && (
              <circle className="br-dot br-dot-merged" cx={r.startX} cy={r.y} r={3.5}>
                <title>{`${b.name} is at ${short(b.head)}, already in ${resp.target}`}</title>
              </circle>
            )}
            {r.uncommittedX !== null && (
              <circle className="br-dot br-dot-dirty" cx={r.uncommittedX} cy={r.y} r={4.5}>
                <title>{`${plural(b.worktree?.uncommitted ?? 0, 'file')} changed in ${b.worktree?.path ?? ''}, not committed`}</title>
              </circle>
            )}
            <text className="br-name" x={r.labelX} y={r.y - 3}>
              {b.name}
              <title>{`${short(b.head)} ${b.subject}`}</title>
            </text>
            <Badges items={r.badges} x={r.labelX} y={r.y + 13} />
            {into === b.name && selected && (
              <text className="br-into-tag" x={g.width - G.pad} y={r.y - 3} textAnchor="end">
                ⇠ {selected} merges here
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
