/**
 * "Allow always" rules, as the Settings tab lists them (Amendment 48).  TRACK A.
 *
 * A rule exists twice. Conductor keeps its own row (`session_rules`), which is what
 * makes the arbiter allow a call without asking. And the suggestion that produced it
 * was handed to Claude Code as `updatedPermissions`, which may have written it into a
 * settings file, depending on the suggestion's `destination`.
 *
 * Revoking deletes Conductor's row and nothing else. The user decided Conductor never
 * edits those files, so this only finds the copy, read-only, and says which file holds
 * which entry, so the user can remove it themselves.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RuleCopy, RuleView } from '@conductor/shared';
import type { Db } from '../db/index.js';
import { getAgent, getJob, getProject, type RuleRecord } from './store.js';

/** `Bash(git status:*)`, the way Claude Code writes a rule in `permissions.allow`. */
export function ruleEntry(toolName: string, ruleContent: string | null): string {
  return ruleContent ? `${toolName}(${ruleContent})` : toolName;
}

/**
 * The file a destination names. `cwd` is where the agent ran — its job's worktree — since
 * that is the folder Claude Code's project and local settings are relative to.
 */
export function settingsFileFor(destination: string, cwd: string | null, claudeDir: string): string | null {
  switch (destination) {
    case 'localSettings':
      return cwd ? join(cwd, '.claude', 'settings.local.json') : null;
    case 'projectSettings':
      return cwd ? join(cwd, '.claude', 'settings.json') : null;
    case 'userSettings':
      return join(claudeDir, 'settings.json');
    default:
      // 'session' and 'cliArg' last as long as the run that was given them.
      return null;
  }
}

/** Whether `file`'s `permissions.allow` holds `entry`. Null when it can't be read. */
export function fileHolds(file: string, entry: string, read: (f: string) => string = (f) => readFileSync(f, 'utf8')): boolean | null {
  try {
    const parsed = JSON.parse(read(file)) as { permissions?: { allow?: unknown } };
    const allow = parsed.permissions?.allow;
    return Array.isArray(allow) ? allow.includes(entry) : false;
  } catch {
    return null;
  }
}

function claudeDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
}

export function describeRule(db: Db, r: RuleRecord): RuleView {
  const agent = r.agentId ? getAgent(db, r.agentId) : undefined;
  const cwd = agent ? (getJob(db, agent.jobId)?.worktreePath ?? null) : (getProject(db, r.projectId)?.path ?? null);
  const destination = typeof (r.suggestion as { destination?: unknown } | null)?.destination === 'string'
    ? ((r.suggestion as { destination: string }).destination)
    : null;
  let copy: RuleCopy | null = null;
  if (destination) {
    const entry = ruleEntry(r.toolName, r.ruleContent);
    const file = settingsFileFor(destination, cwd, claudeDir());
    copy = { destination, file, entry, present: file ? fileHolds(file, entry) : null };
  }
  return {
    id: r.id,
    projectId: r.projectId,
    toolName: r.toolName,
    ruleContent: r.ruleContent,
    grantedAt: r.createdAt,
    agent: agent ? { id: agent.id, role: agent.role } : null,
    copy,
  };
}
