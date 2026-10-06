/**
 * Reading a tool call we did not design.
 *
 * Track E owns this file.
 *
 * `PendingRequest.input` is `unknown` by contract — the shape varies per tool
 * and the daemon passes it through untouched. The permission card's whole job is
 * to show the user the *exact* thing that will run, so every accessor here is
 * narrow and total: it either finds a real string or it says it didn't.
 */

import type { PendingRequest, PermissionSuggestion } from '@conductor/shared';

function record(input: unknown): Record<string, unknown> | null {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function str(input: unknown, key: string): string | null {
  const obj = record(input);
  const v = obj?.[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * The field that holds the thing that will actually happen, if there is one.
 * Returning the *key* as well as the value is what lets "edit & run" rebuild a
 * correct `updatedInput` instead of guessing.
 */
export interface PrimaryField {
  key: string;
  value: string;
}

const PRIMARY_KEYS = ['command', 'file_path', 'path', 'url', 'pattern', 'query'] as const;

export function primaryField(input: unknown): PrimaryField | null {
  for (const key of PRIMARY_KEYS) {
    const value = str(input, key);
    if (value !== null) return { key, value };
  }
  return null;
}

/** Everything else worth showing, so nothing about the call is hidden. */
export function secondaryFields(input: unknown, exclude: string | null): Array<[string, string]> {
  const obj = record(input);
  if (!obj) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === exclude) continue;
    if (v === null || v === undefined) continue;
    const rendered = typeof v === 'string' ? v : JSON.stringify(v);
    if (rendered === undefined || rendered.length === 0) continue;
    out.push([k, rendered]);
  }
  return out;
}

/** Pretty JSON for the raw view and for the generic "edit & run" editor. */
export function inputJson(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

/**
 * The rule to persist for "allow all session".
 *
 * `localSettings` is preferred deliberately: it writes the rule to
 * `.claude/settings.local.json`, which is what actually stops the twelfth
 * interruption. A `session`-scoped rule dies with the process and the user gets
 * asked again tomorrow.
 */
export function preferredSuggestion(
  suggestions: readonly PermissionSuggestion[] | undefined,
): PermissionSuggestion | null {
  if (!suggestions || suggestions.length === 0) return null;
  return suggestions.find((s) => s.destination === 'localSettings') ?? suggestions[0] ?? null;
}

/**
 * Ordered so the persisting rule goes first — the daemon applies what it gets,
 * and the card has already told the user which destination it prefers.
 */
export function orderedSuggestions(
  suggestions: readonly PermissionSuggestion[] | undefined,
): PermissionSuggestion[] {
  if (!suggestions) return [];
  return [...suggestions].sort((a, b) => {
    const rank = (s: PermissionSuggestion) => (s.destination === 'localSettings' ? 0 : 1);
    return rank(a) - rank(b);
  });
}

/** Human summary of what a suggestion would persist, for the button's label. */
export function suggestionRule(s: PermissionSuggestion | null): string | null {
  if (!s) return null;
  const rules = s['rules'];
  if (!Array.isArray(rules)) return null;
  const parts: string[] = [];
  for (const r of rules) {
    const obj = record(r);
    const tool = typeof obj?.['toolName'] === 'string' ? obj['toolName'] : null;
    const content = typeof obj?.['ruleContent'] === 'string' ? obj['ruleContent'] : null;
    if (content) parts.push(tool ? `${tool}(${content})` : content);
    else if (tool) parts.push(tool);
  }
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Where a persisted rule would land, in words the user recognises. */
export function destinationLabel(destination: string): string {
  switch (destination) {
    case 'localSettings':
      return '.claude/settings.local.json — persists';
    case 'projectSettings':
      return '.claude/settings.json — persists, shared';
    case 'userSettings':
      return 'user settings — persists everywhere';
    case 'session':
      return 'this session only';
    default:
      return destination;
  }
}

/** One-line identity for the queue and the notification body. */
export function requestTitle(r: PendingRequest): string {
  if (r.kind === 'question') {
    const n = r.questions?.length ?? 0;
    const opts = r.questions?.[0]?.options.length ?? 0;
    return n > 1 ? `question · ${n} questions` : `question · ${opts} options`;
  }
  const primary = primaryField(r.input);
  return primary ? `${r.toolName} · ${primary.value}` : r.toolName;
}

// ─────────────────────────────────────────────────────────────────────────────
// Option previews
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'style',
]);

/**
 * Defence in depth for `QuestionOption.preview`.
 *
 * The contract says the fragment arrives sanitized, and we render it because
 * being a browser is the entire reason this screen can show Claude's mockups
 * where a terminal orchestrator shows nothing. But it is still model-generated
 * markup heading for `innerHTML`, so we strip the handful of constructs that
 * should never survive a sanitizer anyway: script-ish elements, `on*` handlers,
 * and `javascript:` URLs. Cheap, no dependency, and it fails closed.
 *
 * Returns null when there is nothing renderable left — the caller then shows
 * the description alone, which is why `preview` being absent is not an error.
 */
export function sanitizePreview(html: string | undefined): string | null {
  if (typeof html !== 'string' || html.trim().length === 0) return null;

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(`<div id="atn-root">${html}</div>`, 'text/html');
  } catch {
    return null;
  }
  const root = doc.getElementById('atn-root');
  if (!root) return null;

  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (FORBIDDEN_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.replace(/[\u0000- ]/g, '').toLowerCase();
      const isUrlish = name === 'href' || name === 'src' || name === 'xlink:href';
      if (
        name.startsWith('on') ||
        (isUrlish && (value.startsWith('javascript:') || value.startsWith('data:text/html')))
      ) {
        el.removeAttribute(attr.name);
      }
    }
  }

  const out = root.innerHTML.trim();
  return out.length > 0 ? out : null;
}
