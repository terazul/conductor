/**
 * Shared presentational primitives and formatters.  TRACK B.
 *
 * Used by all three of Track B's screens so a "working" dot on the Fleet grid
 * and a "working" dot in an agent lane are provably the same element.
 *
 * Colour discipline: every status maps to exactly one token, via STATUS_KEY.
 * `need` (amber) is reserved for `blocked` — an agent that cannot continue
 * without a human. Nothing else in this file may reach for it.
 */

import type { AgentStatus, ModelCatalog } from '@conductor/shared';
import { modelGroups } from '../lib/models.js';
import { CLAUDE, providerLabel } from '../lib/providers.js';
import type { Activity } from './clock.js';
import './ui.css';

/**
 * The open/closed triangle every fold uses: it points right when closed and turns down
 * when open. The navigator's submenus and the composer's agent settings (Amendment 110)
 * share it, so a fold looks the same wherever it is. Styled by `.sh-nav-chev` (shell.css).
 */
export function Chevron({ open }: { open: boolean }) {
  return <i className={`sh-nav-chev${open ? ' is-open' : ''}`} aria-hidden="true" />;
}

/** AgentStatus → token family. The single place the mapping is decided. */
export const STATUS_KEY: Record<AgentStatus, 'live' | 'need' | 'fail' | 'done' | 'queue' | 'idle'> =
  {
    working: 'live',
    blocked: 'need',
    failed: 'fail',
    done: 'done',
    queued: 'queue',
    paused: 'idle',
    // --idle, not --fail. Terminating an agent is a decision, not a fault, and a red
    // card would read as "something went wrong here" every time you tidied up.
    stopped: 'idle',
  };

/**
 * Short label for a status tag. `done` reads `finished` (Amendment 93) — plain,
 * not "unseen" or "new": that distinction stays per job, in `lib/seen.ts`.
 */
export const STATUS_WORD: Record<AgentStatus, string> = {
  working: 'working',
  blocked: 'needs you',
  failed: 'failed',
  done: 'finished',
  queued: 'queued',
  paused: 'paused',
  stopped: 'stopped',
};

export function Dot({ status }: { status: AgentStatus }) {
  return <i className={`ui-dot d-${STATUS_KEY[status]}`} aria-hidden="true" />;
}

/**
 * `live` and `done` render filled (Amendment 93) — the two states someone scans
 * the grid for, working and finished. The rest stay tonal; see ui.css.
 */
export function Tag({
  tone,
  children,
}: {
  tone: 'live' | 'need' | 'fail' | 'done' | 'queue' | 'idle';
  children: React.ReactNode;
}) {
  return <span className={`ui-tag t-${tone}`}>{children}</span>;
}

/**
 * The engine an agent runs on, beside its name or model (Amendment 80). Nothing for
 * Claude, so every screen from before reads exactly as it did.
 */
export function ProviderBadge({ provider }: { provider: string | undefined }) {
  if (!provider || provider === CLAUDE) return null;
  return (
    <span className="ui-prov" title={`Runs on ${providerLabel(provider)}`}>
      {providerLabel(provider)}
    </span>
  );
}

/**
 * The activity histogram. Bars are real tool calls per 15s bucket.
 *
 * A flat series renders grey and still — it must never be mistaken for work.
 * Heights are scaled against the series maximum so small but real activity is
 * still legible rather than a row of stubs.
 */
export function Spark({
  activity,
  tone = 'live',
}: {
  activity: Activity;
  tone?: 'live' | 'need';
}) {
  const { bars, moving } = activity;
  const max = Math.max(1, ...bars);
  const total = bars.reduce((a, b) => a + b, 0);
  return (
    <span
      className={`ui-spark${moving ? '' : ' is-flat'}${tone === 'need' ? ' is-need' : ''}`}
      title={moving ? `${total} tool calls in the last 2 min` : 'no tool calls in the last 2 min'}
    >
      {bars.map((n, i) => (
        <i
          key={i}
          style={{
            height: n === 0 ? '6%' : `${12 + (n / max) * 84}%`,
            // Deterministic stagger so the bars don't march in lockstep, and
            // don't re-randomise on every render either.
            animationDelay: `${((i * 0.37) % 2.4).toFixed(2)}s`,
          }}
        />
      ))}
    </span>
  );
}

// ── formatters ──────────────────────────────────────────────────────────────

/** `04:12`, or `1:12:40` once it runs over an hour. */
export function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** `12m40s`, `41s` — how long someone has been kept waiting. */
export function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function fmtMoney(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/** `76.2k`, `880`. */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** `acme-api` → `AA`, `payments-svc` → `PS`, `docs` → `DO`. */
export function initials(name: string): string {
  const parts = name.split(/[-_.\s/]+/).filter(Boolean);
  if (parts.length >= 2) {
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  }
  return (parts[0] ?? name).slice(0, 2).toUpperCase();
}

/** Collapse an absolute path to `~/src/thing` when it sits under $HOME-ish. */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

/** Signed diff numbers, coloured by direction. */
export function DiffNums({ added, removed }: { added: number; removed: number }) {
  return (
    <>
      <b className="ui-pos">+{added}</b> <b className="ui-neg">−{removed}</b>
    </>
  );
}

/**
 * A picker of exact model ids, grouped Claude first. (Amendment 40)
 *
 * `value` is always offered, even when the catalog doesn't list it — an agent created
 * before the list, or on a model since retired, still shows what it has rather than
 * silently showing something else. `none` is an extra first choice that means "no
 * override" (Spawn's "per role").
 */
export function ModelSelect({
  catalog,
  value,
  onChange,
  none,
  onRefresh,
  loading = false,
  disabled = false,
  title,
}: {
  catalog: ModelCatalog | null;
  value: string;
  onChange: (id: string) => void;
  none?: string;
  onRefresh?: () => void;
  loading?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const groups = modelGroups(catalog);
  const listed = groups.some((g) => g.models.some((m) => m.id === value));
  return (
    <span className="ui-model">
      <select
        className="ui-select"
        value={value}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(e.target.value)}
      >
        {none !== undefined && <option value="">{none}</option>}
        {value && !listed && (
          <option value={value}>
            {value}
            {catalog?.source === 'gateway' ? ' · not served' : ''}
          </option>
        )}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label === m.id ? m.id : `${m.label} — ${m.id}`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {onRefresh && (
        <button
          type="button"
          className="ui-refresh"
          onClick={onRefresh}
          disabled={loading}
          title="Ask the model API again for what it serves"
          aria-label="Refresh the model list"
        >
          {loading ? '…' : '↻'}
        </button>
      )}
    </span>
  );
}
