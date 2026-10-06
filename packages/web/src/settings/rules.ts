/**
 * "Allow always" rules, in words (Amendment 48). Pure, so lib/verify.ts checks them.
 */

import type { RuleView } from '@conductor/shared';
import { api } from '../lib/feed.js';
import { homeish } from './storage.js';

/** `Bash · npm test:*`, or the bare tool for a rule that covers all of it. */
export function ruleTitle(r: Pick<RuleView, 'toolName' | 'ruleContent'>): string {
  return r.ruleContent ? `${r.toolName} · ${r.ruleContent}` : `${r.toolName} · any call`;
}

/** Who earned it, and when. */
export function ruleOrigin(r: Pick<RuleView, 'agent' | 'grantedAt'>, now = Date.now()): string {
  const who = r.agent ? `${r.agent.role} asked` : 'from before Conductor recorded who asked';
  const t = Date.parse(r.grantedAt);
  if (Number.isNaN(t)) return who;
  const days = Math.floor((now - t) / 86_400_000);
  const when = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return `${who} · ${when}`;
}

/**
 * Where Claude Code's own copy is, said so the user can remove it. Conductor never edits
 * that file — the user's choice — so this is the whole of what it does about it.
 */
export function copyLine(r: Pick<RuleView, 'copy'>): string | null {
  const c = r.copy;
  if (!c) return null;
  if (!c.file) return 'Claude Code kept its own copy for that run only; nothing else to remove.';
  const where = homeish(c.file);
  if (c.present === true) return `Claude Code also allows it from ${where}, as "${c.entry}". Remove that line to stop it there too.`;
  if (c.present === false) return `Claude Code was asked to keep it in ${where}; it isn't there now.`;
  return `Claude Code may also allow it from ${where}, as "${c.entry}". The file couldn't be read to check.`;
}

/** Said beside every revoke button: what revoking does not reach. */
export const REVOKE_NOTE =
  "Revoking stops Conductor allowing it from the next request. An agent that is running keeps what its session was given until its next run.";

export function listRules(projectId: string): Promise<{ rules: RuleView[] }> {
  return api(`/api/projects/${encodeURIComponent(projectId)}/rules`);
}

export function revokeRule(ruleId: string): Promise<{ removed: RuleView }> {
  return api(`/api/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
}
